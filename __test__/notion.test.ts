import {
    buildAllPossiblePairs,
    generatePairProgrammingSessions,
    isRetryableNotionError,
    withNotionRetry,
} from '../src/notion';

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
