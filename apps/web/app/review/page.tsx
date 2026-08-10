import type { Metadata } from "next";

import { ReviewWorkspace } from "../../components/review/review-workspace";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  robots: { follow: false, index: false },
  title: "Privat tilbudsvurdering | Handleplan",
};

export default function ReviewPage() {
  return (
    <div className="app-frame">
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="/review" aria-label="Handleplan, privat vurdering">
            <span className="brand-mark" aria-hidden="true"><span /></span>
            Handleplan
          </a>
          <nav aria-label="Privat meny">
            <a className="active" href="/review" aria-current="page">Vurdering</a>
            <a href="/status">Offentlig status</a>
          </nav>
        </div>
      </header>
      <ReviewWorkspace />
    </div>
  );
}
