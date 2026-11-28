import type { Metadata, Viewport } from "next";
import { NavBar } from "@/components/nav-bar";
import { authEnabled } from "@/lib/auth";
import { strictModeActive } from "@/lib/strict-mode";
import { stagingMode } from "@/lib/staging-mode";
import { withBasePath } from "@/lib/base-path";
import { clientErrorScript } from "@/lib/visit-counter";
import "./globals.css";

export const metadata: Metadata = {
  title: "hevy2garmin",
  description: "Sync your Hevy workouts to Garmin Connect",
};

export const viewport: Viewport = {
  themeColor: "#F3F6F5",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Optional error reports: forwarded only when a collector is configured. */}
        <script dangerouslySetInnerHTML={{ __html: clientErrorScript(withBasePath("/api/client-error")) }} />
      </head>
      <body className="bg-base text-text min-h-screen antialiased">
        {stagingMode() && (
          <div role="status" className="bg-warm-bg px-4 py-2 text-center text-sm font-semibold text-text">
            Synthetic staging: every workout and activity here is simulated. No real account is connected and nothing leaves this deployment.
          </div>
        )}
        <NavBar authEnabled={authEnabled()} strictMode={strictModeActive()} />
        <div className="pb-24 md:pb-0">{children}</div>
      </body>
    </html>
  );
}
