export class CryptoUtils {
	private static HEX_OCTETS: string[] = (() => {
		const octets: string[] = new Array(256);
		for (let i = 0; i < 256; i++) {
			octets[i] = i.toString(16).padStart(2, '0');
		}
		return octets;
	})();

	private static HEX_MAP: Record<string, number> = (() => {
		const map: Record<string, number> = {};
		for (let i = 0; i < 256; i++) {
			const hex = i.toString(16).padStart(2, '0');
			map[hex] = i;
			map[hex.toUpperCase()] = i;
		}
		return map;
	})();

	public static bufToHex(buffer: Uint8Array): string {
		let hex = '';
		for (let i = 0; i < buffer.length; i++) {
			hex += CryptoUtils.HEX_OCTETS[buffer[i]];
		}
		return hex;
	}

	public static hexToBuf(hex: string): Uint8Array {
		const cleanHex = hex.startsWith('\\x') ? hex.slice(2) : hex;
		const len = cleanHex.length;
		if (len % 2 !== 0) {
			throw new Error('Invalid hex string');
		}
		const view = new Uint8Array(len / 2);
		for (let i = 0; i < len; i += 2) {
			const byteStr = cleanHex.substring(i, i + 2);
			view[i >> 1] = CryptoUtils.HEX_MAP[byteStr] ?? parseInt(byteStr, 16);
		}
		return view;
	}

	public static stringToHex(str: string): string {
		const encoder = new TextEncoder();
		const bytes = encoder.encode(str);
		let hex = '\\x';
		for (let i = 0; i < bytes.length; i++) {
			hex += CryptoUtils.HEX_OCTETS[bytes[i]];
		}
		return hex;
	}

	public static hexToString(hex: string): string {
		const cleanHex = hex.startsWith('\\x') ? hex.slice(2) : hex;
		const len = cleanHex.length;
		const bytes = new Uint8Array(len / 2);
		for (let i = 0; i < len; i += 2) {
			const byteStr = cleanHex.substring(i, i + 2);
			bytes[i >> 1] = CryptoUtils.HEX_MAP[byteStr] ?? parseInt(byteStr, 16);
		}
		const decoder = new TextDecoder();
		return decoder.decode(bytes);
	}
}
