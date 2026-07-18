import type { ReactNode } from "react";
import type { Metadata } from "next";
import Script from "next/script";

import { ServiceWorkerRegistration } from "../components/pwa/service-worker-registration";

import "./globals.css";

export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  title: "Handleplan",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const publicBuildId = process.env.NEXT_PUBLIC_HANDLEPLAN_BUILD_ID ?? "";
  return (
    <html lang="nb">
      <head>
        <meta content={publicBuildId} name="handleplan-public-build-id" />
        <Script src="/zod-jitless-v1.js" strategy="beforeInteractive" />
      </head>
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
