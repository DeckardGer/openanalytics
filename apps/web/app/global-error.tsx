"use client";

import { SITE_EMAIL } from "@/lib/site";

/**
 * The last-resort boundary: a crash in the root layout itself lands here,
 * where the app's CSS and fonts may not exist anymore — so everything is
 * inline styles over system fonts, dependent on nothing that can also be
 * broken. Must render its own <html> and <body> by contract.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "12px",
          textAlign: "center",
          padding: "24px",
          background: "#ffffff",
          color: "#454545",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "20px", fontWeight: 500 }}>
          Open Analytics hit an error
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: "360px",
            fontSize: "14px",
            lineHeight: 1.6,
            color: "#737373",
          }}
        >
          Something broke below everything else. Reloading usually fixes it
          {SITE_EMAIL ? `; if it keeps happening, email ${SITE_EMAIL}.` : "."}
        </p>
        <button
          onClick={reset}
          style={{
            marginTop: "8px",
            padding: "8px 16px",
            borderRadius: "10px",
            border: "none",
            background: "#296FF0",
            color: "#ffffff",
            fontSize: "14px",
            fontWeight: 500,
            cursor: "pointer",
          }}
          type="button"
        >
          Reload
        </button>
      </body>
    </html>
  );
}
