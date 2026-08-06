import { Modal, App, Notice, Setting } from 'obsidian';
import * as QRCode from 'qrcode';

export class QrDisplayModal extends Modal {
    constructor(app: App, private payload: string) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Network Setup Credentials' });
        contentEl.createEl('p', { text: 'Scan this QR code from a mobile device, or click the QR code to copy the string to your clipboard.' });

        // QR Code Container
        const container = contentEl.createDiv({ cls: 'crdt-sync-settings-qr' });
        container.style.textAlign = 'center';
        container.style.margin = '16px 0';
        container.style.cursor = 'pointer';

        const canvas = container.createEl('canvas');
        canvas.title = 'Click to copy connection string';

        QRCode.toCanvas(canvas, this.payload, { width: 256 }, (error: Error | null | undefined) => {
            if (error) {
                console.error('Failed to generate QR Code:', error);
                container.createEl('p', { text: 'Failed to generate QR Code. Please check the console.' });
            }
        });

        // Click QR code to copy to clipboard
        container.addEventListener('click', () => {
            this.copyToClipboard();
        });

        // Display string payload and explicit Copy button
        new Setting(contentEl)
            .setName('Setup String')
            .setDesc('Copy this string directly to onboard another desktop device.')
            .addTextArea((text) => {
                text.setValue(this.payload);
                text.inputEl.rows = 3;
                text.inputEl.style.width = '100%';
                text.inputEl.style.fontFamily = 'monospace';
                text.inputEl.style.fontSize = '11px';
                text.inputEl.readOnly = true;
            })
            .addButton((btn) =>
                btn
                    .setButtonText('Copy String')
                    .setCta()
                    .onClick(() => this.copyToClipboard())
            );
    }

    private copyToClipboard() {
        navigator.clipboard.writeText(this.payload)
            .then(() => {
                new Notice('Setup payload copied to clipboard!');
            })
            .catch((err) => {
                console.error('Failed to copy setup payload:', err);
                new Notice('Failed to copy to clipboard.');
            });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

