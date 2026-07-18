import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    background_color: "#f4f0e7",
    description: "Handlelisten du kan ta med i butikken, lagret lokalt på enheten.",
    display: "standalone",
    icons: [
      {
        purpose: "any",
        sizes: "any",
        src: "/icons/handleplan.svg",
        type: "image/svg+xml",
      },
      {
        purpose: "maskable",
        sizes: "any",
        src: "/icons/handleplan-maskable.svg",
        type: "image/svg+xml",
      },
    ],
    id: "/planlegg/handle",
    lang: "nb-NO",
    name: "Handleplan Handlemodus",
    orientation: "portrait-primary",
    scope: "/",
    short_name: "Handleplan",
    start_url: "/planlegg/handle",
    theme_color: "#123f2b",
  };
}
