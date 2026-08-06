import { Modal, App } from 'obsidian';
import * as QRCode from 'qrcode';

export class QrDisplayModal extends Modal {
    constructor(app: App, private payload: string) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Network Setup QR Code' });
        contentEl.createEl('p', { text: 'Scan this QR code from another device to copy the connection credentials securely.' });

        const container = contentEl.createDiv({ cls: 'crdt-sync-settings-qr' });
        const canvas = container.createEl('canvas');

        QRCode.toCanvas(canvas, this.payload, { width: 256 }, (error) => {
            if (error) {
                console.error('Failed to generate QR Code:', error);
                container.createEl('p', { text: 'Failed to generate QR Code. Please check the console.' });
            }
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
