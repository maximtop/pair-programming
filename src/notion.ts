import { Client, collectPaginatedAPI } from '@notionhq/client';
import type {
    CreatePageResponse,
    PageObjectResponse,
    QueryDatabaseParameters,
    QueryDatabaseResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { format } from 'date-fns';

import { PAIR_SESSIONS_TABLE_ID, TEAM_MEMBERS_TABLE_ID, VACATIONS_TABLE_ID } from './config';
import { TeamMember } from './types';

import 'dotenv/config';

const notionFetch = typeof fetch === 'function'
    ? async (
        url: string,
        init?: { body?: string, headers?: Record<string, string>, method?: string },
    ): Promise<Response> => fetch(url, {
        body: init?.body,
        headers: init?.headers,
        method: init?.method,
    })
    : undefined;

// Initializing a client
const notion = new Client({
    auth: process.env.NOTION_API_KEY, // or your API key as a string
    fetch: notionFetch,
});

const NOTION_QUERY_ATTEMPTS = 4;
const NOTION_QUERY_RETRY_DELAY_MS = 1000;

const RETRYABLE_NOTION_ERROR_CODES = new Set([
    'ERR_STREAM_PREMATURE_CLOSE',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
]);

interface ErrorWithDetails {
    code?: string,
    message?: string,
    status?: number,
}

interface NotionRetryOptions {
    attempts?: number,
    getDelayMs?: (attempt: number) => number,
    sleep?: (delayMs: number) => Promise<void>,
}

const sleep = async (delayMs: number): Promise<void> => new Promise((resolve) => {
    setTimeout(resolve, delayMs);
});

const getNotionRetryDelayMs = (attempt: number): number => NOTION_QUERY_RETRY_DELAY_MS * (2 ** (attempt - 1));

const getNotionErrorDetails = (error: unknown): ErrorWithDetails => {
    if (!error || typeof error !== 'object') {
        return {};
    }

    return error as ErrorWithDetails;
};

const getNotionErrorSummary = (error: unknown): string => {
    const errorDetails = getNotionErrorDetails(error);

    if (errorDetails.code) {
        return errorDetails.code;
    }

    if (errorDetails.status) {
        return `HTTP ${errorDetails.status}`;
    }

    if (errorDetails.message) {
        return errorDetails.message;
    }

    return 'unknown error';
};

export const isRetryableNotionError = (error: unknown): boolean => {
    const errorDetails = getNotionErrorDetails(error);

    if (errorDetails.code && RETRYABLE_NOTION_ERROR_CODES.has(errorDetails.code)) {
        return true;
    }

    if (errorDetails.status && (errorDetails.status === 429 || errorDetails.status >= 500)) {
        return true;
    }

    return errorDetails.message?.includes('Premature close') ?? false;
};

export const withNotionRetry = async <T>(
    operation: () => Promise<T>,
    label: string,
    options: NotionRetryOptions = {},
): Promise<T> => {
    const attempts = options.attempts ?? NOTION_QUERY_ATTEMPTS;
    const getDelayMs = options.getDelayMs ?? getNotionRetryDelayMs;
    const sleepFn = options.sleep ?? sleep;

    const run = async (attempt: number): Promise<T> => {
        try {
            return await operation();
        } catch (error) {
            if (attempt >= attempts || !isRetryableNotionError(error)) {
                throw error;
            }

            const delayMs = getDelayMs(attempt);

            // eslint-disable-next-line no-console
            console.warn(
                `${label} failed with ${getNotionErrorSummary(error)} `
                + `(attempt ${attempt}/${attempts}). Retrying in ${delayMs}ms.`,
            );

            await sleepFn(delayMs);
            return run(attempt + 1);
        }
    };

    return run(1);
};

const queryDatabase = async (
    parameters: QueryDatabaseParameters,
    label: string,
): Promise<QueryDatabaseResponse['results']> => withNotionRetry(
    () => collectPaginatedAPI(notion.databases.query, parameters),
    label,
);

const TeamMembersColumn = {
    Name: 'Name',
    Slack: 'Slack',
};

const VacationsColumn = {
    TeamMembers: 'Team members',
    Date: 'Date',
};

const PairSessionsColumn = {
    TeamMembers: 'Team members',
    Projects: 'Projects',
    Date: 'Date',
    Status: 'Status',
};

/**
 * Type guards to narrow down the property types
 * @param property
 */
function isTitleProperty(property: any): property is { title: { plain_text: string }[] } {
    return property && property.type === 'title' && Array.isArray(property.title);
}

/**
 * Type guards to narrow down the property types
 * @param property
 */
function isRichTextProperty(property: any): property is { rich_text: { plain_text: string }[] } {
    return property && property.type === 'rich_text' && Array.isArray(property.rich_text);
}

/**
 * Returns all team members
 */
const getTeamMembers = async (): Promise<TeamMember[]> => {
    const blocks = await queryDatabase({
        database_id: TEAM_MEMBERS_TABLE_ID,
    }, 'Query team members');

    return blocks
        .filter((block): block is PageObjectResponse => block.object === 'page')
        .map((block) => {
            const nameProperty = block.properties[TeamMembersColumn.Name];
            const slackProperty = block.properties[TeamMembersColumn.Slack];

            const name = isTitleProperty(nameProperty) ? nameProperty.title[0].plain_text : 'Unknown';
            const slack = isRichTextProperty(slackProperty) ? slackProperty.rich_text[0].plain_text : 'Unknown';

            return {
                id: block.id,
                name,
                slack,
            };
        });
};

interface Vacation {
    id: string;
    memberId: string,
    start: string,
    end: string,
}

/**
 * Returns vacations for the next week
 */
const getVacations = async (): Promise<Vacation[]> => {
    const blocks = await queryDatabase({
        database_id: VACATIONS_TABLE_ID,
        filter: {
            property: 'Date',
            date: {
                after: new Date().toISOString(),
                before: new Date(new Date().setDate(new Date().getDate() + 7)).toISOString(),
            },
        },
    }, 'Query vacations');

    return blocks
        .filter((block: any): block is PageObjectResponse => block.object === 'page')
        .map((block) => {
            const memberIdProperty = block.properties[VacationsColumn.TeamMembers];
            const dateProperty = block.properties[VacationsColumn.Date];

            const memberId = memberIdProperty?.type === 'relation' && memberIdProperty.relation.length > 0
                ? memberIdProperty.relation[0].id
                : 'Unknown';
            const startDate = dateProperty?.type === 'date' && dateProperty.date?.start
                ? dateProperty.date.start
                : 'Unknown';
            const endDate = dateProperty?.type === 'date' && dateProperty.date?.end
                ? dateProperty.date.end
                : 'Unknown';

            return {
                id: block.id,
                memberId,
                start: startDate,
                end: endDate,
            };
        });
};

interface PairSession {
    id: string,
    members: TeamMember[],
    date: string,
    projectIds: string[],
}

/**
 * Returns all previous sessions until the current date
 */
const getPreviousPairSessions = async (): Promise<PairSession[]> => {
    const blocks = await queryDatabase({
        database_id: PAIR_SESSIONS_TABLE_ID,
        filter: {
            property: 'Date',
            date: {
                before: new Date().toISOString(),
            },
        },
    }, 'Query previous pair sessions');

    return blocks.map((block: any) => {
        const memberIds = block.properties[PairSessionsColumn.TeamMembers].relation.map((member: any) => member);
        const projectIds = block.properties[PairSessionsColumn.Projects].relation.map((proj: any) => proj.id);
        const date = block.properties[PairSessionsColumn.Date].date.start;

        return {
            id: block.id,
            date,
            members: memberIds,
            projectIds,
        };
    });
};

/**
 * Adds a pair session
 * @param pair
 */
const addPairSession = async (pair: Pair<TeamMember>): Promise<CreatePageResponse> => {
    const today = new Date();
    const dateString = format(today, 'yyyy-MM-dd'); // Format the date to 'YYYY-MM-DD'

    const response = await notion.pages.create({
        parent: { database_id: PAIR_SESSIONS_TABLE_ID },
        properties: {
            [PairSessionsColumn.TeamMembers]: {
                relation: [
                    { id: pair[0].id },
                    { id: pair[1].id },
                ],
            },
            [PairSessionsColumn.Status]: {
                type: 'select',
                select: {
                    name: 'Planned',
                },
            },
            [PairSessionsColumn.Date]: {
                type: 'date',
                date: {
                    start: dateString, // Use formatted date string here
                },
            },
        },
    });

    return response;
};

/**
 * Adds pair sessions
 * @param pairs
 */
export const addPairSessions = async (pairs: Pair<TeamMember>[]): Promise<void> => {
    const promises = pairs.map((pair) => addPairSession(pair));
    await Promise.all(promises);
};

type Pair<T extends BaseTeamMember> = [T, T];

interface BaseTeamMember {
    id: string,
}

interface BasePairSession<T> {
    id: string,
    members: T[]
}

/**
 * Creates a unique key for a pair of members
 * @param members
 */
function createPairKey(members: BaseTeamMember[]): string {
    return members.map((m) => m.id).sort().join(':');
}

/**
 * Creates a map to count occurrences of each pair in previous sessions
 * @param previousSessions
 */
function createPairsCountMap<
    T extends BaseTeamMember,
    P extends BasePairSession<T>,
>(previousSessions: P[]): Map<string, number> {
    return previousSessions.reduce((acc, session) => {
        const key = createPairKey(session.members);
        acc.set(key, (acc.get(key) || 0) + 1);
        return acc;
    }, new Map());
}

/**
 * Generates all possible unique pairs from the given array of members
 * @param members
 */
function generateAllUniquePairs<T extends BaseTeamMember>(members: T[]): Pair<T>[] {
    const pairs: Pair<T>[] = [];
    for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
            pairs.push([members[i], members[j]]);
        }
    }
    return pairs;
}

/**
 * Finds optimal pairs using a dynamic programming approach with caching
 * @param remainingPairs
 * @param pairsCountMap
 * @param currentPairs
 * @param currentScore
 * @param dpCache
 */
function findOptimalPairsWithCaching<T extends BaseTeamMember>(
    remainingPairs: Pair<T>[],
    pairsCountMap: Map<string, number>,
    currentPairs: Pair<T>[] = [],
    currentScore = 0,
    dpCache = new Map(),
): { pairs: Pair<T>[]; score: number } {
    const cacheKey = remainingPairs.map((p) => createPairKey(p)).join('|');
    if (dpCache.has(cacheKey)) {
        return dpCache.get(cacheKey);
    }

    if (remainingPairs.length === 0) {
        return { pairs: currentPairs, score: currentScore };
    }

    // Initialize bestResult with a default valid object
    let bestResult: { pairs: Pair<T>[]; score: number } = {
        pairs: [],
        score: Number.MAX_SAFE_INTEGER,
    };

    for (const pair of remainingPairs) {
        const key = createPairKey(pair);
        const pairScore = pairsCountMap.get(key) || 0;
        const newScore = currentScore + pairScore;
        const newPairs = [...currentPairs, pair];
        const filteredRemainingPairs = remainingPairs.filter((p) => !p.includes(pair[0]) && !p.includes(pair[1]));

        const result = findOptimalPairsWithCaching(filteredRemainingPairs, pairsCountMap, newPairs, newScore, dpCache);

        if (result.score < bestResult.score) {
            bestResult = result;
        }
    }

    dpCache.set(cacheKey, bestResult);
    return bestResult;
}

/**
 * Generates pair programming sessions based on the previous sessions and available team members
 * @param availableTeamMembers
 * @param previousSessions
 */
export const generatePairProgrammingSessions = <T extends BaseTeamMember, P extends BasePairSession<T>>(
    availableTeamMembers: T[],
    previousSessions: P[],
): Pair<T>[] => {
    // Create a map to count occurrences of each pair in previous sessions
    const pairsCountMap = createPairsCountMap<T, P>(previousSessions);

    // Generate all possible unique pairs from available team members
    const allPairs = generateAllUniquePairs(availableTeamMembers);

    // Find optimal pairings using a dynamic programming approach with caching
    const optimalPairsResult = findOptimalPairsWithCaching<T>(allPairs, pairsCountMap);
    return optimalPairsResult.pairs;
};

/**
 * Returns team members who are not on vacation
 * @param teamMembers
 * @param vacations
 */
const getAvailableTeamMembers = (teamMembers: TeamMember[], vacations: Vacation[]): TeamMember[] => {
    const currentDate = new Date(); // Assuming we're generating for the current week.
    const availableTeamMembers = teamMembers.filter((teamMember) => !vacations.some((vacation) => {
        return vacation.memberId === teamMember.id
        && currentDate >= new Date(vacation.start)
        && currentDate <= new Date(vacation.end);
    }));
    return availableTeamMembers;
};

/**
 * Builds all possible pairs from the given array of members
 * @param allMembers
 */
export const buildAllPossiblePairs = <T>(allMembers: T[]): [T, T][] => {
    const pairs: [T, T][] = [];

    for (let i = 0; i < allMembers.length; i += 1) {
        for (let j = i + 1; j < allMembers.length; j += 1) {
            pairs.push([allMembers[i], allMembers[j]]);
        }
    }

    return pairs;
};

/**
 * Returns all possible pairs for the current week
 */
export const getPairs = async (): Promise<Pair<TeamMember>[]> => {
    const teamMembers = await getTeamMembers();
    const vacations = await getVacations();
    const previousPairSessions = await getPreviousPairSessions();

    const availableTeamMembers = getAvailableTeamMembers(teamMembers, vacations);
    return generatePairProgrammingSessions(availableTeamMembers, previousPairSessions);
};
