"use client";
import { useEffect, useState } from "react";

/** Renders a real QR code as inline SVG. The generator is loaded on demand so it never bloats other pages. */
export function QrCode({ value, size = 160 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("qrcode").then((m) => m.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" })).then((s) => live && setSvg(s)).catch(() => undefined);
    return () => { live = false; };
  }, [value]);
  if (!svg) return <div style={{ width: size, height: size }} className="animate-pulse rounded bg-ink-100" />;
  return <div role="img" aria-label="QR code" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg.replace("<svg", `<svg width="${size}" height="${size}"`) }} />;
}
