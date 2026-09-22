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

const SW_REGISTER = `if ("serviceWorker" in navigator) { window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); }); }`;

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
