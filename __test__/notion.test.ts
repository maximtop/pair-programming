import { buildAllPossiblePairs, generatePairProgrammingSessions } from '../src/notion';

describe('buildAllPossiblePairs', () => {
    it('builds pairs', () => {
        const maxim = { name: 'maxim' };
        const vladimir = { name: 'vladimir' };
        const dmitriy = { name: 'dmitriy' };
        expect(buildAllPossiblePairs([maxim, vladimir, dmitriy]))
            .toEqual([[maxim, vladimir], [maxim, dmitriy], [vladimir, dmitriy]]);
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
