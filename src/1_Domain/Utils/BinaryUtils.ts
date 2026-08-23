import { PluginSettings } from '@presentation/Plugin';

export function isBinaryPath(path: string): boolean {
	const extIdx = path.lastIndexOf('.');
	if (extIdx === -1) return false;
	const ext = path.substring(extIdx + 1).toLowerCase();
	return [
		'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico',
		'pdf', 'zip', 'tar', 'gz', '7z', 'rar',
		'mp3', 'wav', 'ogg', 'm4a', 'flac',
		'mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv',
		'woff', 'woff2', 'ttf', 'otf', 'eot'
	].includes(ext);
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
	let binary = '';
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
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
