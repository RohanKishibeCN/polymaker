import { Client } from '@notionhq/client';
import { config } from './config';

const notion = new Client({ auth: config.notion.token });
const databaseId = config.notion.databaseId;

function toRichTextBlocks(content: string, chunkSize: number): Array<{ text: { content: string } }> {
  const blocks: Array<{ text: { content: string } }> = [];
  for (let i = 0; i < content.length; i += chunkSize) {
    blocks.push({ text: { content: content.substring(i, i + chunkSize) } });
  }
  return blocks;
}

export async function logTrade(name: string, content: string) {
  try {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        Name: {
          title: [
            {
              text: {
                content: name,
              },
            },
          ],
        },
        Date: {
          date: {
            start: new Date().toISOString(),
          },
        },
        Type: {
          select: {
            name: 'trades',
          },
        },
        Content: {
          rich_text: toRichTextBlocks(content, 2000),
        },
      },
    });
    console.log(`[Notion] Logged trade: ${name}`);
  } catch (error) {
    console.error(`[Notion] Failed to log trade:`, error);
  }
}

export async function logDailySummary(name: string, content: string) {
  try {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        Name: {
          title: [
            {
              text: {
                content: name,
              },
            },
          ],
        },
        Date: {
          date: {
            start: new Date().toISOString(),
          },
        },
        Type: {
          select: {
            name: 'dailysummary',
          },
        },
        Content: {
          rich_text: toRichTextBlocks(content, 2000),
        },
      },
    });
    console.log(`[Notion] Logged daily summary: ${name}`);
  } catch (error) {
    console.error(`[Notion] Failed to log daily summary:`, error);
  }
}
