import { Client, collectPaginatedAPI } from '@notionhq/client';
import type {
    CreatePageResponse,
    PageObjectResponse,
    QueryDatabaseParameters,
    QueryDatabaseResponse,
} from '@notionhq/client/build/src/api-endpoints';
import { addDays, format } from 'date-fns';

import { PAIR_SESSIONS_TABLE_ID, TEAM_MEMBERS_TABLE_ID, VACATIONS_TABLE_ID } from './config';
import { BaseTeamMember, Pair, TeamMember } from './types';

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
    Enabled: 'Enabled',
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
 * Maps a team members database page to a team member; blank fields become 'Unknown'
 * @param page
 */
export const parseTeamMember = (page: PageObjectResponse): TeamMember => {
    const nameProperty = page.properties[TeamMembersColumn.Name];
    const slackProperty = page.properties[TeamMembersColumn.Slack];

    const name = isTitleProperty(nameProperty) && nameProperty.title.length > 0
        ? nameProperty.title[0].plain_text
        : 'Unknown';
    const slack = isRichTextProperty(slackProperty) && slackProperty.rich_text.length > 0
        ? slackProperty.rich_text[0].plain_text
        : 'Unknown';

    return {
        id: page.id,
        name,
        slack,
    };
};

/**
 * Returns team members marked as enabled
 */
const getTeamMembers = async (): Promise<TeamMember[]> => {
    const blocks = await queryDatabase({
        database_id: TEAM_MEMBERS_TABLE_ID,
        filter: {
            property: TeamMembersColumn.Enabled,
            checkbox: { equals: true },
        },
    }, 'Query team members');

    return blocks
        .filter((block): block is PageObjectResponse => block.object === 'page')
        .map(parseTeamMember);
};

export interface Vacation {
    id: string;
    memberId: string,
    start: string,
    // Null for a single-day vacation
    end: string | null,
}

const VACATIONS_LOOKAHEAD_DAYS = 7;

/**
 * Builds the filter for vacations that start before a week from `now`.
 * There is deliberately no lower bound: ongoing vacations must be returned too.
 * `getAvailableTeamMembers` picks the ones that cover the current date.
 */
export const buildVacationsFilter = (now: Date): QueryDatabaseParameters['filter'] => ({
    property: 'Date',
    date: { before: addDays(now, VACATIONS_LOOKAHEAD_DAYS).toISOString() },
});

/**
 * Maps a vacations database page to a vacation
 * @param page
 */
export const parseVacation = (page: PageObjectResponse): Vacation => {
    const memberIdProperty = page.properties[VacationsColumn.TeamMembers];
    const dateProperty = page.properties[VacationsColumn.Date];

    const memberId = memberIdProperty?.type === 'relation' && memberIdProperty.relation.length > 0
        ? memberIdProperty.relation[0].id
        : 'Unknown';
    const start = dateProperty?.type === 'date' && dateProperty.date?.start
        ? dateProperty.date.start
        : 'Unknown';
    const end = dateProperty?.type === 'date' && dateProperty.date?.end
        ? dateProperty.date.end
        : null;

    return {
        id: page.id,
        memberId,
        start,
        end,
    };
};

/**
 * Returns vacations for the next week
 */
const getVacations = async (): Promise<Vacation[]> => {
    const blocks = await queryDatabase({
        database_id: VACATIONS_TABLE_ID,
        filter: buildVacationsFilter(new Date()),
    }, 'Query vacations');

    return blocks
        .filter((block: any): block is PageObjectResponse => block.object === 'page')
        .map(parseVacation);
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
 * Counts how many previous sessions each member took part in
 * @param previousSessions
 */
function createSessionsCountMap<
    T extends BaseTeamMember,
    P extends BasePairSession<T>,
>(previousSessions: P[]): Map<string, number> {
    const counts = new Map<string, number>();
    previousSessions.forEach((session) => {
        session.members.forEach((member) => {
            counts.set(member.id, (counts.get(member.id) || 0) + 1);
        });
    });
    return counts;
}

interface PairingResult<T extends BaseTeamMember> {
    pairs: Pair<T>[],
    score: number,
    // The member left without a pair when the number of members is odd
    sitOut?: T,
}

interface PairingContext<T extends BaseTeamMember> {
    pairsCountMap: Map<string, number>,
    sessionsCountMap: Map<string, number>,
    cache: Map<string, PairingResult<T>>,
}

/**
 * Compares pairings: the lower repeat score wins.
 * On equal scores, the one whose sit-out member had more previous sessions wins, then the one with the smaller id.
 * This evens out past session counts instead of leaving out the first member every week.
 * @param a
 * @param b
 * @param sessionsCountMap
 */
function isBetterPairing<T extends BaseTeamMember>(
    a: PairingResult<T>,
    b: PairingResult<T>,
    sessionsCountMap: Map<string, number>,
): boolean {
    if (a.score !== b.score) {
        return a.score < b.score;
    }

    if (!a.sitOut || !b.sitOut) {
        return false;
    }

    const aSessions = sessionsCountMap.get(a.sitOut.id) || 0;
    const bSessions = sessionsCountMap.get(b.sitOut.id) || 0;
    if (aSessions !== bSessions) {
        return aSessions > bSessions;
    }

    return a.sitOut.id < b.sitOut.id;
}

/**
 * Finds the pairing of `members` with the lowest total count of repeated pairs.
 * With an odd number of members, one member stays unpaired; see `isBetterPairing` for how they are chosen.
 *
 * The best pairing of a set of members does not depend on how the other members were paired,
 * so results are cached per set of remaining members.
 * @param members
 * @param context
 */
function findOptimalPairs<T extends BaseTeamMember>(
    members: T[],
    context: PairingContext<T>,
): PairingResult<T> {
    if (members.length === 0) {
        return { pairs: [], score: 0 };
    }

    if (members.length === 1) {
        return { pairs: [], score: 0, sitOut: members[0] };
    }

    const cacheKey = members.map((m) => m.id).sort().join('|');
    const cached = context.cache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const [first, ...rest] = members;

    // With an odd count, the first member may be the one who stays unpaired
    let best: PairingResult<T> = members.length % 2 === 1
        ? { ...findOptimalPairs(rest, context), sitOut: first }
        : { pairs: [], score: Number.POSITIVE_INFINITY };

    rest.forEach((partner, index) => {
        const pair: Pair<T> = [first, partner];
        const result = findOptimalPairs(rest.filter((_, i) => i !== index), context);
        const candidate: PairingResult<T> = {
            pairs: [pair, ...result.pairs],
            score: (context.pairsCountMap.get(createPairKey(pair)) || 0) + result.score,
            sitOut: result.sitOut,
        };

        if (isBetterPairing(candidate, best, context.sessionsCountMap)) {
            best = candidate;
        }
    });

    context.cache.set(cacheKey, best);
    return best;
}

/**
 * Generates pair programming sessions based on the previous sessions and available team members
 * @param availableTeamMembers
 * @param previousSessions
 */
export const generatePairProgrammingSessions = <T extends BaseTeamMember, P extends BasePairSession<T>>(
    availableTeamMembers: T[],
    previousSessions: P[],
): Pair<T>[] => findOptimalPairs(availableTeamMembers, {
    pairsCountMap: createPairsCountMap<T, P>(previousSessions),
    sessionsCountMap: createSessionsCountMap<T, P>(previousSessions),
    cache: new Map(),
}).pairs;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a Notion date value is at or before `now`.
 * A date-only value is compared as a calendar date in the local time zone.
 * @param value
 * @param now
 */
const isOnOrBefore = (value: string, now: Date): boolean => (DATE_ONLY_PATTERN.test(value)
    ? value <= format(now, 'yyyy-MM-dd')
    : new Date(value) <= now);

/**
 * Whether a Notion date value is at or after `now`.
 * A date-only value covers the whole day.
 * @param value
 * @param now
 */
const isOnOrAfter = (value: string, now: Date): boolean => (DATE_ONLY_PATTERN.test(value)
    ? value >= format(now, 'yyyy-MM-dd')
    : new Date(value) >= now);

/**
 * Whether the vacation covers `now`. Both ends are inclusive.
 * A single-day vacation covers the whole day, even when entered with a time.
 * @param vacation
 * @param now
 */
const isOnVacation = (vacation: Vacation, now: Date): boolean => {
    if (vacation.end === null) {
        const day = vacation.start.slice(0, 10);
        return isOnOrBefore(day, now) && isOnOrAfter(day, now);
    }

    return isOnOrBefore(vacation.start, now) && isOnOrAfter(vacation.end, now);
};

/**
 * Returns team members who are not on vacation at `now`
 * @param teamMembers
 * @param vacations
 * @param now
 */
export const getAvailableTeamMembers = <T extends BaseTeamMember>(
    teamMembers: T[],
    vacations: Vacation[],
    now: Date,
): T[] => teamMembers.filter((teamMember) => !vacations.some((vacation) => {
    return vacation.memberId === teamMember.id && isOnVacation(vacation, now);
}));

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

    const availableTeamMembers = getAvailableTeamMembers(teamMembers, vacations, new Date());
    return generatePairProgrammingSessions(availableTeamMembers, previousPairSessions);
};
