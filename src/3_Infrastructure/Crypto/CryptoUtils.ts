export class CryptoUtils {
    private static HEX_CHARS = "0123456789abcdef";

    public static bufToHex(buffer: Uint8Array): string {
        let hex = '';
        for (let i = 0; i < buffer.length; i++) {
            const b = buffer[i];
            hex += this.HEX_CHARS[(b >> 4) & 0xf] + this.HEX_CHARS[b & 0xf];
        }
        return hex;
    }

    public static hexToBuf(hex: string): Uint8Array {
        const cleanHex = hex.startsWith('\\x') ? hex.slice(2) : hex;
        if (cleanHex.length % 2 !== 0) {
            throw new Error('Invalid hex string');
        }
        const view = new Uint8Array(cleanHex.length / 2);
        for (let i = 0; i < view.length; i++) {
            view[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
        }
        return view;
    }

    public static stringToHex(str: string): string {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(str);
        let hex = '\\x';
        for (let i = 0; i < bytes.length; i++) {
            const b = bytes[i];
            hex += ('0' + b.toString(16)).slice(-2);
        }
        return hex;
    }

    public static hexToString(hex: string): string {
        const cleanHex = hex.startsWith('\\x') ? hex.slice(2) : hex;
        const bytes = new Uint8Array(cleanHex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
        }
        const decoder = new TextDecoder();
        return decoder.decode(bytes);
    }
}
