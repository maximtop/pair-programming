import { describePlan, main } from '../src/index';
import { addPairSessions, getPairingPlan, getSessionIdsGeneratedThisWeek } from '../src/notion';
import { publishToSlack } from '../src/slack';
import { PairingPlan, TeamMember } from '../src/types';

jest.mock('../src/notion', () => ({
    addPairSessions: jest.fn(),
    getPairingPlan: jest.fn(),
    getSessionIdsGeneratedThisWeek: jest.fn(),
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
        jest.mocked(getSessionIdsGeneratedThisWeek).mockResolvedValue([]);
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    const generatedIds = ['s1', 's2', 's3'];

    const getLog = (): string => logSpy.mock.calls.map(([message]) => message).join('\n');

    it('writes the pairs to Notion and posts them to Slack', async () => {
        await main({ dryRun: false });

        expect(getPairingPlan).toHaveBeenCalledWith(expect.any(Date), []);
        expect(logSpy).toHaveBeenCalledWith(describePlan(plan));
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
        jest.mocked(getSessionIdsGeneratedThisWeek).mockResolvedValue(generatedIds);

        await main({ dryRun: false });

        expect(getPairingPlan).not.toHaveBeenCalled();
        expect(addPairSessions).not.toHaveBeenCalled();
        expect(publishToSlack).not.toHaveBeenCalled();
        expect(getLog()).toContain('already generated (3 sessions in Notion)');
        expect(getLog()).toContain('move this week\'s generated sessions to the trash in Notion and run again');
    });

    it('plans without this week\'s sessions on a dry run when the pairs are already generated', async () => {
        jest.mocked(getSessionIdsGeneratedThisWeek).mockResolvedValue(generatedIds);

        await main({ dryRun: true });

        expect(getPairingPlan).toHaveBeenCalledWith(expect.any(Date), generatedIds);
        expect(logSpy).toHaveBeenCalledWith(describePlan(plan));
        expect(getLog()).toContain('a real run would do nothing');
        expect(addPairSessions).not.toHaveBeenCalled();
        expect(publishToSlack).not.toHaveBeenCalled();
    });

    it('writes and posts nothing when there are no pairs', async () => {
        jest.mocked(getPairingPlan).mockResolvedValue({ pairs: [], unpaired: [member('Max')], onVacation: [] });

        await main({ dryRun: false });

        expect(addPairSessions).not.toHaveBeenCalled();
        expect(publishToSlack).not.toHaveBeenCalled();
        expect(getLog()).toContain('Fewer than two members are available');
    });
});
