import { addPairSessions, getPairingPlan, getSessionIdsGeneratedThisWeek } from './notion';
import { publishToSlack } from './slack';
import { PairingPlan } from './types';

export interface RunOptions {
    // Print the plan without writing to Notion or posting to Slack
    dryRun: boolean;
}

const log = (message: string): void => {
    // eslint-disable-next-line no-console
    console.log(message);
};

/**
 * Describes the plan for the run log
 * @param plan
 */
export const describePlan = (plan: PairingPlan): string => {
    const names = (members: { name: string }[]): string => members.map((member) => member.name).join(', ');
    const lines = ['Pairs:'];

    plan.pairs.forEach((pair, idx) => {
        lines.push(`${idx + 1}. ${pair[0].name} & ${pair[1].name}`);
    });

    if (plan.pairs.length === 0) {
        lines.push('(none)');
    }

    if (plan.unpaired.length > 0) {
        lines.push(`No pair this week: ${names(plan.unpaired)}`);
    }

    if (plan.onVacation.length > 0) {
        lines.push(`On vacation: ${names(plan.onVacation)}`);
    }

    return lines.join('\n');
};

export const main = async ({ dryRun }: RunOptions): Promise<void> => {
    const now = new Date();
    const generatedIds = await getSessionIdsGeneratedThisWeek(now);

    if (generatedIds.length > 0 && !dryRun) {
        log(`Pairs for this week are already generated (${generatedIds.length} sessions in Notion). Nothing to do.`);
        log('If an earlier run failed half-way, or to regenerate the pairs, '
            + 'move this week\'s generated sessions to the trash in Notion and run again.');
        return;
    }

    // Only a dry run gets here with generated sessions. They are left out of the history:
    // otherwise the search would avoid this week's own pairs and print a different plan.
    const plan = await getPairingPlan(now, generatedIds);
    log(describePlan(plan));

    if (dryRun) {
        log('Dry run: nothing is written to Notion or posted to Slack.');
        if (generatedIds.length > 0) {
            log(`${generatedIds.length} sessions are already generated this week, so a real run would do nothing. `
                + 'The plan above leaves them out of the history: it is what this code would generate for this week.');
        }
        return;
    }

    if (plan.pairs.length === 0) {
        log('Fewer than two members are available: nothing is written to Notion or posted to Slack.');
        return;
    }

    await addPairSessions(plan.pairs);
    await publishToSlack(plan.pairs, plan.unpaired);
};
