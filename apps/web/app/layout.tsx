import type { ReactNode } from "react";
import type { Metadata } from "next";

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
  return (
    <html lang="nb">
      <body>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
