import { Modal, App, Setting, Notice } from 'obsidian';
import { Html5Qrcode } from 'html5-qrcode';

export class QrScannerModal extends Modal {
    private html5QrcodeScanner: Html5Qrcode | null = null;

    constructor(app: App, private onScanSuccess: (decodedText: string) => void) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Import Setup Credentials' });

        const nativeSyncEnabled = (this.app as any).internalPlugins?.plugins?.sync?.enabled;
        if (nativeSyncEnabled) {
            const warning = contentEl.createDiv({ cls: 'crdt-sync-warning' });
            warning.style.backgroundColor = 'var(--background-modifier-error)';
            warning.style.padding = '10px';
            warning.style.borderRadius = '5px';
            warning.style.marginBottom = '15px';
            warning.createEl('h3', { text: '⚠️ Conflict Warning' });
            warning.createEl('p', { text: 'For Obsidian CRDT Sync to function correctly and avoid data corruption, please disable the official Obsidian Sync plugin in your Core Plugins settings.' });
        }

        // 1. Direct Paste Fallback (Ideal for Desktop)
        contentEl.createEl('h4', { text: 'Paste Connection String' });
        let inputPayload = '';
        new Setting(contentEl)
            .setName('Payload String')
            .setDesc('Paste the obsidian-sync:// string generated from your other device.')
            .addText((text) =>
                text
                    .setPlaceholder('obsidian-sync://...')
                    .onChange((val) => {
                        inputPayload = val.trim();
                    })
            )
            .addButton((btn) =>
                btn
                    .setButtonText('Import')
                    .setCta()
                    .onClick(() => {
                        if (!inputPayload) {
                            new Notice('Please paste a valid connection string.');
                            return;
                        }
                        this.onScanSuccess(inputPayload);
                        this.close();
                    })
            );

        contentEl.createEl('hr');

        // 2. Camera Scanner (For Mobile / Webcams)
        contentEl.createEl('h4', { text: 'Or Scan via Camera' });
        contentEl.createEl('p', { text: 'Align the QR Code within the camera frame below.' });

        const readerDiv = contentEl.createDiv({ attr: { id: 'crdt-sync-reader' } });

        setTimeout(() => {
            try {
                this.html5QrcodeScanner = new Html5Qrcode('crdt-sync-reader');
                this.html5QrcodeScanner
                    .start(
                        { facingMode: 'environment' },
                        {
                            fps: 10,
                            qrbox: { width: 200, height: 200 }
                        },
                        (decodedText) => {
                            this.onScanSuccess(decodedText);
                            this.close();
                        },
                        (errorMessage: string) => {
                            console.debug('QR Frame Scan ignored:', errorMessage);
                        }
                    )
                    .catch(() => {
                        readerDiv.createEl('p', {
                            text: 'Camera unreadable or access denied. Please use the paste box above.',
                            cls: 'mod-warning'
                        });
                    });
            } catch (err: unknown) {
                readerDiv.createEl('p', {
                    text: 'Camera access not supported on this device. Please use the paste box above.',
                    cls: 'mod-warning'
                });
            }
        }, 100);
    }

    onClose() {
        if (this.html5QrcodeScanner) {
            this.html5QrcodeScanner
                .stop()
                .catch((err: unknown) => console.error('Error stopping scanner:', err));
        }
        const { contentEl } = this;
        contentEl.empty();
    }
}