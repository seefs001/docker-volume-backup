#!/usr/bin/env bun

import { $ } from "bun";
import { join } from "path";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { S3Client } from 'bun';

const ENV = {
    BOT_TOKEN: process.env.BOT_TOKEN!,
    BOT_ADMIN_CHAT_IDS: process.env.BOT_ADMIN_CHAT_IDS!.split(','),
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID!,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY!,
    S3_BUCKET: process.env.S3_BUCKET!,
    S3_ENDPOINT: process.env.S3_ENDPOINT!,
    BACKUP_RETENTION_DAYS: Number(process.env.BACKUP_RETENTION_DAYS!) || 7
} as const;

Object.entries(ENV).forEach(([key, value]) => {
    if (value === undefined || value === '') {
        throw new Error(`Missing environment variable: ${key}`);
    }
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_ROOT = join(__dirname, "volume-backup");
const CURRENT_DATE = new Date().toISOString().split('T')[0];
const PREVIOUS_DATE = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const BACKUP_DIR = join(BACKUP_ROOT, CURRENT_DATE);
const PREVIOUS_BACKUP_DIR = join(BACKUP_ROOT, PREVIOUS_DATE);

const s3Client = new S3Client({
    accessKeyId: ENV.S3_ACCESS_KEY_ID,
    secretAccessKey: ENV.S3_SECRET_ACCESS_KEY,
    bucket: ENV.S3_BUCKET,
    endpoint: ENV.S3_ENDPOINT
});

type ErrorWithMessage = {
    message: string;
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
    return (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as Record<string, unknown>).message === 'string'
    );
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
    if (isErrorWithMessage(maybeError)) return maybeError;

    try {
        return new Error(JSON.stringify(maybeError));
    } catch {
        return new Error(String(maybeError));
    }
}

function getErrorMessage(error: unknown) {
    return toErrorWithMessage(error).message;
}

async function sendTelegramMessage(message: string, downloadUrl?: string) {
    try {
        const promises = ENV.BOT_ADMIN_CHAT_IDS.map(async chatId => {
            const messageData: any = {
                chat_id: Number(chatId),
                text: message,
                parse_mode: 'HTML'
            };

            // Add inline keyboard if downloadUrl is provided
            if (downloadUrl) {
                messageData.reply_markup = {
                    inline_keyboard: [[
                        {
                            text: '📥 Download Backup',
                            url: downloadUrl
                        }
                    ]]
                };
            }

            const response = await fetch(`https://api.telegram.org/bot${ENV.BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(messageData)
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`Telegram API error (${response.status}): ${errorData}`);
            }

            const result = await response.json();
            if (!result.ok) {
                throw new Error(`Telegram API returned error: ${JSON.stringify(result)}`);
            }

            return result;
        });

        await Promise.all(promises);
        console.log('Telegram notifications sent successfully');
    } catch (error) {
        console.error("Failed to send Telegram message:", getErrorMessage(error));
        throw new Error(`Telegram notification failed: ${getErrorMessage(error)}`);
    }
}

async function main() {
    try {
        await $`mkdir -p ${BACKUP_DIR}`;

        try {
            const previousDirExists = await Bun.file(PREVIOUS_BACKUP_DIR).exists();
            if (previousDirExists) {
                await $`rm -rf ${PREVIOUS_BACKUP_DIR}`;
                console.log(`Deleted previous backup directory: ${PREVIOUS_BACKUP_DIR}`);
            }
        } catch (error) {
            const errorMsg = getErrorMessage(error);
            console.error("Error handling previous backup directory:", errorMsg);
            await sendTelegramMessage(`❌ Error handling previous backup directory: ${errorMsg}`);
        }

        const proc = await $`docker volume ls -q`;
        const volumes = (await proc.text()).trim().split("\n").filter(Boolean);

        if (volumes.length === 0) {
            const msg = "No Docker volumes found to backup";
            console.warn(msg);
            await sendTelegramMessage(`⚠️ ${msg}`);
            return;
        }

        for (const volume of volumes) {
            const backupFile = join(BACKUP_DIR, `${volume}.tar.gz`);
            try {
                await $`docker run --rm -v ${volume}:/_data -v ${BACKUP_DIR}:/backup ubuntu tar czf /backup/${volume}.tar.gz -C /_data .`;
                console.log(`Backup of volume '${volume}' completed: ${backupFile}`);
            } catch (error) {
                const errorMsg = getErrorMessage(error);
                console.error(`Error backing up volume ${volume}:`, errorMsg);
                await sendTelegramMessage(`❌ Error backing up volume ${volume}: ${errorMsg}`);
                throw error;
            }
        }

        const finalArchive = join(BACKUP_ROOT, `${CURRENT_DATE}.tar.gz`);
        await $`cd ${BACKUP_DIR} && tar czf ${finalArchive} .`;
        await $`rm -rf ${BACKUP_DIR}`;

        const s3Key = `backups/${CURRENT_DATE}.tar.gz`;
        const s3File = s3Client.file(s3Key);
        const localFile = Bun.file(finalArchive);

        await s3File.write(localFile);
        console.log(`Backup uploaded to S3: ${s3Key}`);

        const downloadUrl = s3File.presign({
            expiresIn: ENV.BACKUP_RETENTION_DAYS * 24 * 60 * 60,
        });

        const message = `✅ Backup completed successfully!\n\n` +
            `📅 Date: ${CURRENT_DATE}\n` +
            `📦 Volumes: ${volumes.length}\n` +
            `⏱ Link valid for: ${ENV.BACKUP_RETENTION_DAYS} days`;

        await sendTelegramMessage(message, downloadUrl);
        console.log(`Download URL (valid for ${ENV.BACKUP_RETENTION_DAYS} days): ${downloadUrl}`);

        await $`rm -f ${finalArchive}`;
        console.log(`Local backup file deleted: ${finalArchive}`);

    } catch (error) {
        const errorMsg = getErrorMessage(error);
        console.error("Backup process failed:", errorMsg);
        await sendTelegramMessage(`❌ Backup process failed: ${errorMsg}`);
        process.exit(1);
    }
}

main().catch(error => {
    console.error("Fatal error:", getErrorMessage(error));
    process.exit(1);
});
