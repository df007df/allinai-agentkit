import Script from "next/script";
import "../console.css";

export const metadata = {
  title: "allinai-agentkit Console",
  description: "agentkit 本地控制台：客户端、执行与授权一览",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0f14",
};

// The console is served fresh from a local server, so the service worker is
// only useful in a production build (installable PWA, offline shell). In dev
// it would pin stale JS chunks ahead of each rebuild — never register there,
// and actively unregister any worker a previous visit left behind.
const SW_REGISTER =
  process.env.NODE_ENV === "production"
    ? `if ("serviceWorker" in navigator) { window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); }); }`
    : `if ("serviceWorker" in navigator) { navigator.serviceWorker.getRegistrations().then(function (items) { items.forEach(function (item) { item.unregister(); }); }); }`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
      <Script id="register-console-sw" strategy="afterInteractive">
        {SW_REGISTER}
      </Script>
    </html>
  );
}
