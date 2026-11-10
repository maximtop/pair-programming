import { describePlan, main } from '../src/index';
import { addPairSessions, countSessionsGeneratedThisWeek, getPairingPlan } from '../src/notion';
import { publishToSlack } from '../src/slack';
import { PairingPlan, TeamMember } from '../src/types';

jest.mock('../src/notion', () => ({
    addPairSessions: jest.fn(),
    countSessionsGeneratedThisWeek: jest.fn(),
    getPairingPlan: jest.fn(),
}));

jest.mock('../src/slack', () => ({
    publishToSlack: jest.fn(),
}));

const member = (name: string): TeamMember => ({ id: name.toLowerCase(), name, slack: '' });

const plan: PairingPlan = {
    pairs: [[member('Max'), member('Bob')]],
    unpaired: [member('Alice')],
    onVacation: [member('John'), member('Kate')],
};

describe('describePlan', () => {
    it('lists the pairs, the unpaired member and the members on vacation', () => {
        expect(describePlan(plan))
            .toBe('Pairs:\n1. Max & Bob\nNo pair this week: Alice\nOn vacation: John, Kate');
    });

    it('says when there are no pairs', () => {
        expect(describePlan({ pairs: [], unpaired: [], onVacation: [] })).toBe('Pairs:\n(none)');
    });
});

describe('main', () => {
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.mocked(getPairingPlan).mockResolvedValue(plan);
        jest.mocked(countSessionsGeneratedThisWeek).mockResolvedValue(0);
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it('writes the pairs to Notion and posts them to Slack', async () => {
        await main({ dryRun: false });

        expect(addPairSessions).toHaveBeenCalledWith(plan.pairs);
        expect(publishToSlack).toHaveBeenCalledWith(plan.pairs, plan.unpaired);
    });

    it('prints the plan and writes nothing on a dry run', async () => {
        await main({ dryRun: true });

        expect(logSpy).toHaveBeenCalledWith(describePlan(plan));
        expect(addPairSessions).not.toHaveBeenCalled();
        expect(publishToSlack).not.toHaveBeenCalled();
    });

    it('does nothing when the pairs for this week are already generated', async () => {
        jest.mocked(countSessionsGeneratedThisWeek).mockResolvedValue(3);

        await main({ dryRun: false });

        expect(getPairingPlan).not.toHaveBeenCalled();
        expect(addPairSessions).not.toHaveBeenCalled();
        expect(publishToSlack).not.toHaveBeenCalled();
    });

    it('still prints the plan on a dry run when the pairs are already generated', async () => {
        jest.mocked(countSessionsGeneratedThisWeek).mockResolvedValue(3);

        await main({ dryRun: true });

        expect(logSpy).toHaveBeenCalledWith(describePlan(plan));
        expect(addPairSessions).not.toHaveBeenCalled();
        expect(publishToSlack).not.toHaveBeenCalled();
    });
});
