import { addPairSessions, countSessionsGeneratedThisWeek, getPairingPlan } from './notion';
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
    const generatedCount = await countSessionsGeneratedThisWeek(now);

    if (generatedCount > 0 && !dryRun) {
        log(`Pairs for this week are already generated (${generatedCount} sessions in Notion). Nothing to do.`);
        return;
    }

    const plan = await getPairingPlan(now);
    log(describePlan(plan));

    if (dryRun) {
        log('Dry run: nothing is written to Notion or posted to Slack.');
        if (generatedCount > 0) {
            log(`A real run would do nothing: ${generatedCount} sessions are already generated this week.`);
        }
        return;
    }

    await addPairSessions(plan.pairs);
    await publishToSlack(plan.pairs, plan.unpaired);
};
