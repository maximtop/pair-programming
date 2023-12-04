import { Block, WebClient } from '@slack/web-api';

import { Pair, TeamMember } from './types';
import { SLACK_CHANNEL } from './config';

import 'dotenv/config';

const web = new WebClient(process.env.SLACK_TOKEN);

/**
 * Builds a rich message to publish to Slack
 * @param pairs
 */
const buildRichMessage = (pairs: Pair<TeamMember>[]): Block[] => {
    let blocks = [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: '*Current week pairs:*',
            },
        },
        { type: 'divider' },
    ];

    pairs.forEach((pair, idx) => {
        const pairText = `${idx + 1}. *${pair[0].name}* & *${pair[1].name}*`;
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: pairText,
            },
        });
    });

    blocks = blocks.concat([
        {
            type: 'divider',
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: 'cc @extensions',
            },
        }]);

    return blocks;
};

/**
 * Builds a simple message to publish to Slack
 * @param pairs
 */
export const buildSimpleMessage = (pairs: Pair<TeamMember>[]): string => {
    const result = ['Current week pairs:'];
    pairs.forEach((pair, idx) => {
        const pairText = `${idx + 1}. ${pair[0].name} & ${pair[1].name}`
        result.push(pairText);
    });
    result.push('cc @extensions');
    return result.join('\n');
};

/**
 * Publishes a message to Slack
 * @param pairs
 */
export const publishToSlack = async (pairs: Pair<TeamMember>[]): Promise<void> => {
    const richMessage = buildRichMessage(pairs);
    const simpleMessage = buildSimpleMessage(pairs);

    await web.chat.postMessage({
        channel: SLACK_CHANNEL,
        text: simpleMessage,
        blocks: richMessage,
    });
};
