import "server-only";

import QRCode from "qrcode";

export function createAuthenticatorQrCode(otpAuthUri: string) {
  return QRCode.toDataURL(otpAuthUri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 288,
    color: { dark: "#000000", light: "#ffffff" },
  });
}
