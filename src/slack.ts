import { Block, WebClient } from '@slack/web-api';

import { Pair, TeamMember } from './types';
import { SLACK_CHANNEL } from './config';

import 'dotenv/config';

const web = new WebClient(process.env.SLACK_TOKEN);

/**
 * Builds the line naming the members left without a pair
 * @param unpaired
 */
const buildUnpairedText = (unpaired: TeamMember[]): string => {
    return `No pair this week: ${unpaired.map((member) => member.name).join(', ')}`;
};

/**
 * Builds a rich message to publish to Slack
 * @param pairs
 * @param unpaired
 */
const buildRichMessage = (pairs: Pair<TeamMember>[], unpaired: TeamMember[]): Block[] => {
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

    if (unpaired.length > 0) {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: buildUnpairedText(unpaired),
            },
        });
    }

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
 * @param unpaired
 */
export const buildSimpleMessage = (pairs: Pair<TeamMember>[], unpaired: TeamMember[] = []): string => {
    const result = ['Current week pairs:'];
    pairs.forEach((pair, idx) => {
        const pairText = `${idx + 1}. ${pair[0].name} & ${pair[1].name}`;
        result.push(pairText);
    });
    if (unpaired.length > 0) {
        result.push(buildUnpairedText(unpaired));
    }
    result.push('cc @extensions');
    return result.join('\n');
};

/**
 * Publishes a message to Slack
 * @param pairs
 * @param unpaired
 */
export const publishToSlack = async (pairs: Pair<TeamMember>[], unpaired: TeamMember[] = []): Promise<void> => {
    const richMessage = buildRichMessage(pairs, unpaired);
    const simpleMessage = buildSimpleMessage(pairs, unpaired);

    await web.chat.postMessage({
        channel: SLACK_CHANNEL,
        text: simpleMessage,
        blocks: richMessage,
    });
};
