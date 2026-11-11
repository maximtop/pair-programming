import type { PageObjectResponse } from '@notionhq/client/build/src/api-endpoints';

import {
    buildCurrentWeekSessionsFilter,
    buildPairingPlan,
    buildVacationsFilter,
    generatePairProgrammingSessions,
    getAvailableTeamMembers,
    getIdsCreatedBy,
    getSessionWeight,
    isRetryableNotionError,
    parsePairSession,
    parseTeamMember,
    parseVacation,
    withNotionRetry,
} from '../src/notion';
import type { Vacation } from '../src/notion';

describe('isRetryableNotionError', () => {
    it('matches transient stream and network errors', () => {
        expect(isRetryableNotionError({ code: 'ERR_STREAM_PREMATURE_CLOSE' })).toBe(true);
        expect(isRetryableNotionError({ message: 'Premature close' })).toBe(true);
        expect(isRetryableNotionError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('matches rate limit and server errors', () => {
        expect(isRetryableNotionError({ status: 429 })).toBe(true);
        expect(isRetryableNotionError({ status: 500 })).toBe(true);
        expect(isRetryableNotionError({ status: 400 })).toBe(false);
    });
});

describe('withNotionRetry', () => {
    it('retries retryable failures before resolving', async () => {
        const operation = jest.fn()
            .mockRejectedValueOnce({ code: 'ERR_STREAM_PREMATURE_CLOSE' })
            .mockResolvedValue('ok');
        const sleep = jest.fn().mockResolvedValue(undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
            await expect(withNotionRetry(operation, 'Query team members', {
                getDelayMs: () => 0,
                sleep,
            })).resolves.toBe('ok');
        } finally {
            warnSpy.mockRestore();
        }

        expect(operation).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(0);
    });
});

describe('generatePairProgrammingSessions', () => {
    it('generates pair programming sessions', () => {
        const availableMembers = [
            {
                id: 'alice',
            },
            {
                id: 'bob',
            },
            {
                id: 'max',
            },
            {
                id: 'ivan',
            },
        ];
        const previousPairSessions = [
            {
                id: '1',
                weight: 1,
                members: [
                    {
                        id: 'alice',
                    },
                    {
                        id: 'bob',
                    },
                ],
            },
            {
                id: '2',
                weight: 1,
                members: [
                    {
                        id: 'max',
                    },
                    {
                        id: 'ivan',

                    },
                ],
            },
            {
                id: '3',
                weight: 1,
                members: [
                    {
                        id: 'alice',
                    },
                    {
                        id: 'max',
                    },
                ],
            },
            {
                id: '4',
                weight: 1,
                members: [
                    {
                        id: 'bob',
                    },
                    {
                        id: 'ivan',
                    },
                ],
            },
        ];

        const newPairs = generatePairProgrammingSessions(availableMembers, previousPairSessions);

        // Ensure that each new pair is different from all pairs in previous sessions,
        // Because we already have all possible pairs except two, this test passes
        newPairs.forEach((pair) => {
            const pairKey = pair.map((member) => member.id).sort().join(':');
            const previousSessionKeys = previousPairSessions
                .map((session) => session.members
                    .map((member) => member.id)
                    .sort()
                    .join(':'));

            expect(previousSessionKeys).not.toContain(pairKey);
        });
    });
});

describe('buildVacationsFilter', () => {
    it('has only an upper bound so ongoing vacations are returned', () => {
        const now = new Date('2026-11-09T10:00:00.000Z');

        expect(buildVacationsFilter(now)).toEqual({
            property: 'Date',
            date: { before: '2026-11-16T10:00:00.000Z' },
        });
    });
});

describe('generatePairProgrammingSessions optimality', () => {
    type Member = { id: string };
    type Session = { id: string; members: Member[]; weight: number };

    const pairKey = (a: Member, b: Member): string => [a.id, b.id].sort().join(':');

    const countPairs = (sessions: Session[]): Map<string, number> => {
        const counts = new Map<string, number>();
        sessions.forEach(({ members: [a, b] }) => {
            counts.set(pairKey(a, b), (counts.get(pairKey(a, b)) ?? 0) + 1);
        });
        return counts;
    };

    const countSessions = (sessions: Session[]): Map<string, number> => {
        const counts = new Map<string, number>();
        sessions.flatMap((session) => session.members).forEach((member) => {
            counts.set(member.id, (counts.get(member.id) ?? 0) + 1);
        });
        return counts;
    };

    const getSitOut = (pairs: [Member, Member][], members: Member[]): Member => {
        const paired = new Set(pairs.flat());
        const [sitOut] = members.filter((member) => !paired.has(member));
        return sitOut;
    };

    const scorePairs = (pairs: [Member, Member][], counts: Map<string, number>): number => pairs
        .reduce((sum, [a, b]) => sum + (counts.get(pairKey(a, b)) ?? 0), 0);

    // Minimum score over all perfect matchings, by full enumeration
    const bruteForceEven = (members: Member[], counts: Map<string, number>): number => {
        if (members.length === 0) {
            return 0;
        }
        const [first, ...rest] = members;
        return Math.min(...rest.map((partner, index) => (counts.get(pairKey(first, partner)) ?? 0)
            + bruteForceEven(rest.filter((_, i) => i !== index), counts)));
    };

    // For odd counts, also try every member as the one who sits out
    const bruteForce = (members: Member[], counts: Map<string, number>): number => (members.length % 2 === 0
        ? bruteForceEven(members, counts)
        : Math.min(...members.map((_, out) => bruteForceEven(members.filter((__, i) => i !== out), counts))));

    // Deterministic PRNG (mulberry32) so failures are reproducible
    const createRandom = (seed: number): () => number => {
        let state = seed;
        return () => {
            state = (state + 0x6D2B79F5) | 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };

    const createMembers = (count: number): Member[] => Array.from({ length: count }, (_, i) => ({ id: `m${i}` }));

    const expectValidPairing = (pairs: [Member, Member][], members: Member[]): void => {
        const ids = pairs.flat().map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(pairs).toHaveLength(Math.floor(members.length / 2));
    };

    it('avoids a repeated pair that an earlier search path left behind', () => {
        const [a, b, c, d, e, f] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
        const sessions = [
            { id: '1', members: [d, e], weight: 1 },
            { id: '2', members: [d, f], weight: 1 },
            { id: '3', members: [e, f], weight: 1 },
        ];

        const pairs = generatePairProgrammingSessions([a, b, c, d, e, f], sessions);

        expectValidPairing(pairs, [a, b, c, d, e, f]);
        expect(scorePairs(pairs, countPairs(sessions))).toBe(0);
    });

    it.each([4, 5, 6, 7, 8, 9, 10])('matches the brute-force minimum for %i members', (memberCount) => {
        const random = createRandom(memberCount);
        const members = createMembers(memberCount);

        for (let run = 0; run < 30; run += 1) {
            const sessions: Session[] = Array.from({ length: 25 }, (_, i) => {
                const a = Math.floor(random() * memberCount);
                const b = (a + 1 + Math.floor(random() * (memberCount - 1))) % memberCount;
                return { id: String(i), members: [members[a], members[b]], weight: 1 };
            });
            const counts = countPairs(sessions);

            const pairs = generatePairProgrammingSessions(members, sessions);

            expectValidPairing(pairs, members);
            const minScore = bruteForce(members, counts);
            expect(scorePairs(pairs, counts)).toBe(minScore);

            if (memberCount % 2 === 1) {
                // Among members whose sitting out allows the minimum score,
                // the one with the most previous sessions sits out, then the smallest id
                const sessionCounts = countSessions(sessions);
                const [expectedSitOut] = members
                    .filter((member) => bruteForceEven(members.filter((m) => m !== member), counts) === minScore)
                    .sort((a, b) => (sessionCounts.get(b.id) ?? 0) - (sessionCounts.get(a.id) ?? 0)
                        || (a.id < b.id ? -1 : 1));

                expect(getSitOut(pairs, members)).toBe(expectedSitOut);
            }
        }
    });

    it.each([5, 7, 9])('rotates who sits out among %i members while no pair repeats', (memberCount) => {
        const members = createMembers(memberCount);
        const sessions: Session[] = [];
        const sitOuts: Member[] = [];

        for (let week = 0; week < memberCount; week += 1) {
            const pairs = generatePairProgrammingSessions(members, sessions);

            expectValidPairing(pairs, members);
            expect(scorePairs(pairs, countPairs(sessions))).toBe(0);
            sitOuts.push(getSitOut(pairs, members));
            pairs.forEach((pair) => sessions.push({ id: String(sessions.length), members: pair, weight: 1 }));
        }

        expect(new Set(sitOuts).size).toBe(memberCount);
    });
});

describe('getAvailableTeamMembers', () => {
    const alice = { id: 'alice' };
    const bob = { id: 'bob' };

    // Monday 2026-11-09 07:05 in the local time zone; the working days of the week are November 9 to 13
    const mondayMorning = new Date(2026, 10, 9, 7, 5);

    const vacation = (start: string, end: string | null, memberId = 'alice'): Vacation => ({
        id: `${memberId}-${start}`, memberId, start, end,
    });

    it.each([
        ['the whole week', '2026-11-09', '2026-11-13', false],
        ['a range longer than the week', '2026-11-02', '2026-11-20', false],
        ['Tuesday to Friday', '2026-11-10', '2026-11-13', false],
        ['Wednesday to Friday', '2026-11-11', '2026-11-13', false],
        ['Monday to Wednesday', '2026-11-09', '2026-11-11', false],
        ['Wednesday into the next week', '2026-11-11', '2026-11-20', false],
        ['Thursday to Friday', '2026-11-12', '2026-11-13', true],
        ['Monday to Tuesday', '2026-11-09', '2026-11-10', true],
        ['a range from last week ending on Tuesday', '2026-11-02', '2026-11-10', true],
        ['a single day', '2026-11-09', null, true],
        ['Thursday to Sunday', '2026-11-12', '2026-11-15', true],
        ['the weekend only', '2026-11-14', '2026-11-15', true],
        ['a range that ended last Sunday', '2026-11-02', '2026-11-08', true],
        ['a range starting next Monday', '2026-11-16', '2026-11-20', true],
        ['Wednesday to Friday, with times', '2026-11-11T09:00:00.000+02:00', '2026-11-13T18:00:00.000+02:00', false],
        ['Thursday to Friday, with times', '2026-11-12T09:00:00.000+02:00', '2026-11-13T18:00:00.000+02:00', true],
    ])('vacation for %s', (_, start, end, available) => {
        expect(getAvailableTeamMembers([alice, bob], [vacation(start, end)], mondayMorning))
            .toEqual(available ? [alice, bob] : [bob]);
    });

    it('adds up the days of several vacations', () => {
        const vacations = [vacation('2026-11-09', null), vacation('2026-11-12', '2026-11-13')];

        expect(getAvailableTeamMembers([alice, bob], vacations, mondayMorning)).toEqual([bob]);
    });

    it('counts a day covered by two vacations once', () => {
        const vacations = [vacation('2026-11-09', '2026-11-10'), vacation('2026-11-10', null)];

        expect(getAvailableTeamMembers([alice, bob], vacations, mondayMorning)).toEqual([alice, bob]);
    });

    it('counts only the vacations of the member', () => {
        const vacations = [vacation('2026-11-09', '2026-11-10'), vacation('2026-11-11', '2026-11-13', 'bob')];

        expect(getAvailableTeamMembers([alice, bob], vacations, mondayMorning)).toEqual([alice]);
    });

    it.each([
        ['Monday', new Date(2026, 10, 9, 7, 5)],
        ['Thursday', new Date(2026, 10, 12, 16, 45)],
        ['Sunday', new Date(2026, 10, 15, 23, 59)],
    ])('counts the whole week when run on %s', (_, now) => {
        expect(getAvailableTeamMembers([alice, bob], [vacation('2026-11-09', '2026-11-11')], now)).toEqual([bob]);
        expect(getAvailableTeamMembers([alice, bob], [vacation('2026-11-09', '2026-11-10')], now))
            .toEqual([alice, bob]);
    });
});

describe('Notion page parsing', () => {
    // Only the fields the parsers read; the real response has many more
    const createPage = (properties: Record<string, unknown>): PageObjectResponse => ({
        id: 'page-1',
        properties,
    } as unknown as PageObjectResponse);

    const text = (value: string): { plain_text: string } => ({ plain_text: value });

    it('parses a team member', () => {
        const page = createPage({
            Name: { type: 'title', title: [text('Alice')] },
            Slack: { type: 'rich_text', rich_text: [text('U123')] },
        });

        expect(parseTeamMember(page)).toEqual({ id: 'page-1', name: 'Alice', slack: 'U123' });
    });

    it('falls back to Unknown for blank team member fields', () => {
        const page = createPage({
            Name: { type: 'title', title: [] },
            Slack: { type: 'rich_text', rich_text: [] },
        });

        expect(parseTeamMember(page)).toEqual({ id: 'page-1', name: 'Unknown', slack: 'Unknown' });
    });

    it('parses a vacation range', () => {
        const page = createPage({
            'Team members': { type: 'relation', relation: [{ id: 'alice' }] },
            Date: { type: 'date', date: { start: '2026-11-02', end: '2026-11-09', time_zone: null } },
        });

        expect(parseVacation(page)).toEqual({
            id: 'page-1', memberId: 'alice', start: '2026-11-02', end: '2026-11-09',
        });
    });

    it('parses a pair session', () => {
        const page = createPage({
            'Team members': { type: 'relation', relation: [{ id: 'alice' }, { id: 'bob' }] },
            Date: { type: 'date', date: { start: '2026-11-02', end: null, time_zone: null } },
        });

        expect(parsePairSession(page)).toEqual({
            id: 'page-1', members: [{ id: 'alice' }, { id: 'bob' }], date: '2026-11-02',
        });
    });

    it('fails on a pair session without a date', () => {
        const page = createPage({
            'Team members': { type: 'relation', relation: [{ id: 'alice' }, { id: 'bob' }] },
            Date: { type: 'date', date: null },
        });

        expect(() => parsePairSession(page)).toThrow('Pair session page-1 has no "Team members" relation or no date');
    });

    it('keeps single-day vacations without an end and applies them', () => {
        const vacations = ['2026-11-09', '2026-11-11', '2026-11-13'].map((start) => parseVacation(createPage({
            'Team members': { type: 'relation', relation: [{ id: 'alice' }] },
            Date: { type: 'date', date: { start, end: null, time_zone: null } },
        })));

        expect(vacations.map((vacation) => vacation.end)).toEqual([null, null, null]);
        expect(getAvailableTeamMembers([{ id: 'alice' }, { id: 'bob' }], vacations, new Date(2026, 10, 9, 7, 5)))
            .toEqual([{ id: 'bob' }]);
    });
});

describe('buildCurrentWeekSessionsFilter', () => {
    // Local-time dates, so the test does not depend on the machine's time zone
    const monday = new Date(2026, 10, 9);

    it.each([
        ['Monday', new Date(2026, 10, 9, 7, 5)],
        ['Wednesday', new Date(2026, 10, 11, 16, 45)],
        ['Sunday', new Date(2026, 10, 15, 23, 59)],
    ])('starts the week on Monday when run on %s', (_, now) => {
        expect(buildCurrentWeekSessionsFilter(now)).toEqual({
            timestamp: 'created_time',
            created_time: { on_or_after: monday.toISOString() },
        });
    });
});

describe('getIdsCreatedBy', () => {
    it('returns only the pages created by the given user', () => {
        const pages = [
            { id: 'generated-1', created_by: { object: 'user' as const, id: 'bot' } },
            { id: 'added-by-hand', created_by: { object: 'user' as const, id: 'human' } },
            { id: 'generated-2', created_by: { object: 'user' as const, id: 'bot' } },
        ];

        expect(getIdsCreatedBy(pages, 'bot')).toEqual(['generated-1', 'generated-2']);
        expect(getIdsCreatedBy(pages, 'someone-else')).toEqual([]);
    });
});

describe('getSessionWeight', () => {
    // Local-time date, so the test does not depend on the machine's time zone
    const now = new Date(2026, 10, 9, 7, 5);

    it.each([
        ['today', '2026-11-09', 1000],
        ['a week ago', '2026-11-02', 841],
        ['four weeks ago', '2026-10-12', 500],
        ['eight weeks ago', '2026-09-14', 250],
        ['a year ago', '2025-11-10', 0],
        ['four weeks ago, with a local time', '2026-10-12T12:00:00', 500],
        ['in the future', '2026-11-16', 1000],
    ])('weighs a session held %s', (_, date, weight) => {
        expect(getSessionWeight(date, now)).toBe(weight);
    });
});

describe('buildPairingPlan', () => {
    const now = new Date(2026, 10, 9, 7, 5);
    const members = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, name: id.toUpperCase(), slack: '' }));
    const [a, b, c, d, e] = members;

    const getPairKeys = (pairs: { id: string }[][]): string[] => pairs
        .map((pair) => pair.map((member) => member.id).sort().join('-'))
        .sort();

    it('leaves out members on vacation and reports them', () => {
        const vacations = [{
            id: 'v1',
            memberId: e.id,
            start: '2026-11-02',
            end: '2026-11-13',
        }];

        const plan = buildPairingPlan({
            teamMembers: members,
            vacations,
            previousPairSessions: [],
            ignoredSessionIds: [],
            now,
        });

        expect(plan.pairs).toHaveLength(2);
        expect(plan.pairs.flat().map((member) => member.id).sort()).toEqual([a, b, c, d].map((member) => member.id));
        expect(plan.unpaired).toEqual([]);
        expect(plan.onVacation).toEqual([e]);
    });

    it('reports the member left without a pair when the available count is odd', () => {
        const plan = buildPairingPlan({
            teamMembers: members,
            vacations: [],
            previousPairSessions: [],
            ignoredSessionIds: [],
            now,
        });

        expect(plan.pairs).toHaveLength(2);
        expect(plan.unpaired).toHaveLength(1);
        expect(plan.pairs.flat()).not.toContain(plan.unpaired[0]);
        expect(plan.onVacation).toEqual([]);
    });

    it('leaves out the member with the largest weight of past sessions, not the most sessions', () => {
        const plan = buildPairingPlan({
            teamMembers: members,
            vacations: [],
            previousPairSessions: [
                // `a` has two sessions, but nine months ago
                { id: 'ac', members: [a, c], date: '2026-02-02' },
                { id: 'ad', members: [a, d], date: '2026-02-02' },
                // `b` and `e` have one session each, last week
                { id: 'be', members: [b, e], date: '2026-11-02' },
            ],
            ignoredSessionIds: [],
            now,
        });

        expect(plan.unpaired).toEqual([b]);
    });

    it('prefers the pairs that have not met for longest over the pairs that met least often', () => {
        const plan = buildPairingPlan({
            teamMembers: [a, b, c, d],
            vacations: [],
            previousPairSessions: [
                // Three sessions each, nine months ago
                ...['1', '2', '3'].flatMap((n) => [
                    { id: `ab-${n}`, members: [a, b], date: '2026-02-02' },
                    { id: `cd-${n}`, members: [c, d], date: '2026-02-02' },
                ]),
                // One session each, two weeks ago
                { id: 'ad', members: [a, d], date: '2026-10-26' },
                { id: 'bc', members: [b, c], date: '2026-10-26' },
                // One session each, last week
                { id: 'ac', members: [a, c], date: '2026-11-02' },
                { id: 'bd', members: [b, d], date: '2026-11-02' },
            ],
            ignoredSessionIds: [],
            now,
        });

        expect(getPairKeys(plan.pairs)).toEqual(['a-b', 'c-d']);
    });

    describe('ignored sessions', () => {
        const teamMembers = [a, b, c, d];
        const previousPairSessions = [
            { id: 'old-1', members: [a, c], date: '2026-11-02' },
            { id: 'old-2', members: [a, d], date: '2026-11-02' },
            { id: 'this-week-1', members: [a, b], date: '2026-11-09' },
            { id: 'this-week-2', members: [c, d], date: '2026-11-09' },
        ];

        it('avoids the pairs of every session in the history', () => {
            const plan = buildPairingPlan({
                teamMembers,
                vacations: [],
                previousPairSessions,
                ignoredSessionIds: [],
                now,
            });

            expect(getPairKeys(plan.pairs)).not.toEqual(['a-b', 'c-d']);
        });

        it('leaves the ignored sessions out of the history', () => {
            const plan = buildPairingPlan({
                teamMembers,
                vacations: [],
                previousPairSessions,
                ignoredSessionIds: ['this-week-1', 'this-week-2'],
                now,
            });

            expect(getPairKeys(plan.pairs)).toEqual(['a-b', 'c-d']);
        });
    });
});
