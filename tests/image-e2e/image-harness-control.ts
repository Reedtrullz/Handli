import { request as requestHttp } from "node:http";

const hostname = "127.0.0.1";
const controlPort = 3122;
const controlHeader = "x-handleplan-image-e2e-control";
const tokenPattern = /^handleplan-image-control-[0-9a-f]{48}$/u;
const buildIdPattern = /^hpv2-[0-9a-f]{64}$/u;

function controlToken(): string {
  const token = process.env.HANDLEPLAN_IMAGE_E2E_CONTROL_TOKEN ?? "";
  if (!tokenPattern.test(token)) {
    throw new Error("exact-image harness control capability is unavailable");
  }
  return token;
}

function requestControl(
  pathname: string,
  body?: Readonly<Record<string, string>>,
): Promise<void> {
  const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = requestHttp({
      headers: {
        [controlHeader]: controlToken(),
        ...(body === undefined
          ? { "content-length": "0" }
          : {
              "content-length": String(bytes.length),
              "content-type": "application/json; charset=utf-8",
            }),
      },
      host: hostname,
      method: "POST",
      path: pathname,
      port: controlPort,
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 16 * 1024) {
          response.destroy(new Error("exact-image control response exceeded its bound"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once("error", reject);
      response.once("end", () => {
        if (response.statusCode !== 204 || Buffer.concat(chunks).length !== 0) {
          reject(new Error("exact-image harness rejected a bounded control operation"));
          return;
        }
        resolve();
      });
    });
    request.setTimeout(5_000, () => {
      request.destroy(new Error("exact-image harness control timed out"));
    });
    request.once("error", reject);
    request.end(bytes);
  });
}

export function resetImageHarness(): Promise<void> {
  return requestControl("/reset");
}

export function setImageNetworkOffline(offline: boolean): Promise<void> {
  return requestControl(`/network?offline=${offline ? "1" : "0"}`);
}

export function configureImageBuildTransition(
  fromBuildId: string,
  toBuildId: string,
): Promise<void> {
  if (
    !buildIdPattern.test(fromBuildId)
    || !buildIdPattern.test(toBuildId)
    || fromBuildId === toBuildId
  ) {
    throw new Error("exact-image transition requires two distinct canonical build IDs");
  }
  return requestControl("/transition", { fromBuildId, toBuildId });
}
