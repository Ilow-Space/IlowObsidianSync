export function isBinaryPath(path: string): boolean {
	const extIdx = path.lastIndexOf('.');
	if (extIdx === -1) return false;
	const ext = path.substring(extIdx + 1).toLowerCase();
	return [
		'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico',
		'pdf', 'zip', 'tar', 'gz', '7z', 'rar', 'canvas', 'excalidraw',
		'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus',
		'mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv',
		'woff', 'woff2', 'ttf', 'otf', 'eot'
	].includes(ext);
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
	if (typeof Buffer !== 'undefined') {
		return Buffer.from(bytes).toString('base64');
	}

	let binary = '';
	const chunkSize = 0x8000; // 32KB chunks to prevent call stack / string overflow
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const chunk = bytes.subarray(i, i + chunkSize);
		binary += String.fromCharCode(...Array.from(chunk));
	}
	return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
	if (typeof Buffer !== 'undefined') {
		return new Uint8Array(Buffer.from(base64, 'base64'));
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
