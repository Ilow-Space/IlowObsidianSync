
const BINARY_EXTENSIONS = new Set([
	'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
	'pdf', 'epub', 'djvu',
	'mp3', 'm4a', 'ogg', 'wav', 'flac', 'aac', 'mp4', 'mkv', 'webm', 'mov', 'avi',
	'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
	'ttf', 'otf', 'woff', 'woff2',
	'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'bin',
	'canvas', 'excalidraw', 'ogv'
]);

export function isBinaryPath(path: string): boolean {
	if (!path) return false;
	const lastDot = path.lastIndexOf('.');
	if (lastDot === -1 || lastDot === path.length - 1) return false;
	const ext = path.substring(lastDot + 1).toLowerCase();
	return BINARY_EXTENSIONS.has(ext);
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
	}

	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks to prevent call stack / string overflow
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
	}
	return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
	if (typeof Buffer !== 'undefined') {
		const buf = Buffer.from(base64, 'base64');
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	}

	try {
		const binaryString = atob(base64);
		const len = binaryString.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		return bytes;
	} catch (e) {
		return new TextEncoder().encode(base64);
	}
}

export function getArrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return buffer;
}

