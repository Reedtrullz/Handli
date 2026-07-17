import type { Metadata } from "next";

import { OperationsWorkspace } from "../../../components/operations/operations-workspace";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Intern drift | Handleplan",
};

export default function OperationsPage() {
  return (
    <div className="app-frame">
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="/internal/operations" aria-label="Handleplan, intern drift">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            Handleplan
          </a>
          <nav aria-label="Privat driftsmeny">
            <a className="active" href="/internal/operations" aria-current="page">Drift</a>
            <a href="/status">Offentlig status</a>
          </nav>
        </div>
      </header>
      <OperationsWorkspace />
    </div>
  );
}
