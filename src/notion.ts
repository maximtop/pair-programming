import { Client, collectPaginatedAPI } from '@notionhq/client';
import type {
    CreatePageResponse,
    PageObjectResponse,
    QueryDatabaseParameters,
    QueryDatabaseResponse,
} from '@notionhq/client/build/src/api-endpoints';
import {
    addDays,
    differenceInCalendarDays,
    format,
    parseISO,
    startOfWeek,
} from 'date-fns';

import { PAIR_SESSIONS_TABLE_ID, TEAM_MEMBERS_TABLE_ID, VACATIONS_TABLE_ID } from './config';
import {
    BaseTeamMember,
    Pair,
    PairingPlan,
    TeamMember,
} from './types';

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
 * @param now
 */
const getVacations = async (now: Date): Promise<Vacation[]> => {
    const blocks = await queryDatabase({
        database_id: VACATIONS_TABLE_ID,
        filter: buildVacationsFilter(now),
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
 * Returns all previous sessions until `now`
 * @param now
 */
const getPreviousPairSessions = async (now: Date): Promise<PairSession[]> => {
    const blocks = await queryDatabase({
        database_id: PAIR_SESSIONS_TABLE_ID,
        filter: {
            property: 'Date',
            date: {
                before: now.toISOString(),
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

/**
 * Builds the filter for pair sessions created since the start of the current week (Monday).
 * It filters by creation time, not by the `Date` property: teammates move `Date` to the day
 * the session actually took place, so a late session from last week can be dated this week.
 * @param now
 */
export const buildCurrentWeekSessionsFilter = (now: Date): QueryDatabaseParameters['filter'] => ({
    timestamp: 'created_time',
    created_time: { on_or_after: startOfWeek(now, { weekStartsOn: 1 }).toISOString() },
});

/**
 * Returns the ids of the pages created by the given user
 * @param pages
 * @param userId
 */
export const getIdsCreatedBy = (pages: Pick<PageObjectResponse, 'id' | 'created_by'>[], userId: string): string[] => {
    return pages
        .filter((page) => page.created_by.id === userId)
        .map((page) => page.id);
};

/**
 * Returns the ids of the pair sessions this integration has already created this week.
 * Sessions added by hand are not included.
 * @param now
 */
export const getSessionIdsGeneratedThisWeek = async (now: Date): Promise<string[]> => {
    const [bot, blocks] = await Promise.all([
        withNotionRetry(() => notion.users.me({}), 'Get integration user'),
        queryDatabase({
            database_id: PAIR_SESSIONS_TABLE_ID,
            filter: buildCurrentWeekSessionsFilter(now),
        }, 'Query pair sessions created this week'),
    ]);

    return getIdsCreatedBy(
        blocks.filter((block): block is PageObjectResponse => 'created_by' in block),
        bot.id,
    );
};

interface BasePairSession<T> {
    id: string,
    members: T[],
    // How much the session counts as a repeat; see `getSessionWeight`
    weight: number,
}

// A session counts half as much with every `HISTORY_HALF_LIFE_WEEKS` weeks of age
const HISTORY_HALF_LIFE_WEEKS = 4;

// Weight of a session held today. Weights are integers, so equal histories give exactly equal scores.
const SESSION_WEIGHT_SCALE = 1000;

/**
 * Returns how much a session held on `date` counts as a repeat at `now`.
 * Recent sessions weigh more than old ones, so the search prefers the pairs that have not met for longest
 * instead of evening out the totals of the whole history.
 * @param date Notion date value of the session
 * @param now
 */
export const getSessionWeight = (date: string, now: Date): number => {
    const ageWeeks = Math.max(0, differenceInCalendarDays(now, parseISO(date))) / 7;
    return Math.round(SESSION_WEIGHT_SCALE * 0.5 ** (ageWeeks / HISTORY_HALF_LIFE_WEEKS));
};

/**
 * Creates a unique key for a pair of members
 * @param members
 */
function createPairKey(members: BaseTeamMember[]): string {
    return members.map((m) => m.id).sort().join(':');
}

/**
 * Creates a map with the total weight of the previous sessions of each pair
 * @param previousSessions
 */
function createPairWeightsMap<
    T extends BaseTeamMember,
    P extends BasePairSession<T>,
>(previousSessions: P[]): Map<string, number> {
    return previousSessions.reduce((acc, session) => {
        const key = createPairKey(session.members);
        acc.set(key, (acc.get(key) || 0) + session.weight);
        return acc;
    }, new Map());
}

/**
 * Creates a map with the total weight of the previous sessions each member took part in
 * @param previousSessions
 */
function createMemberWeightsMap<
    T extends BaseTeamMember,
    P extends BasePairSession<T>,
>(previousSessions: P[]): Map<string, number> {
    const weights = new Map<string, number>();
    previousSessions.forEach((session) => {
        session.members.forEach((member) => {
            weights.set(member.id, (weights.get(member.id) || 0) + session.weight);
        });
    });
    return weights;
}

interface PairingResult<T extends BaseTeamMember> {
    pairs: Pair<T>[],
    score: number,
    // The member left without a pair when the number of members is odd
    sitOut?: T,
}

interface PairingContext<T extends BaseTeamMember> {
    pairWeightsMap: Map<string, number>,
    memberWeightsMap: Map<string, number>,
    cache: Map<string, PairingResult<T>>,
}

/**
 * Compares pairings: the lower repeat score wins.
 * On equal scores, the one whose sit-out member has the larger total weight of previous sessions wins,
 * then the one with the smaller id.
 * This rotates who sits out instead of leaving out the first member every week.
 * @param a
 * @param b
 * @param memberWeightsMap
 */
function isBetterPairing<T extends BaseTeamMember>(
    a: PairingResult<T>,
    b: PairingResult<T>,
    memberWeightsMap: Map<string, number>,
): boolean {
    if (a.score !== b.score) {
        return a.score < b.score;
    }

    if (!a.sitOut || !b.sitOut) {
        return false;
    }

    const aWeight = memberWeightsMap.get(a.sitOut.id) || 0;
    const bWeight = memberWeightsMap.get(b.sitOut.id) || 0;
    if (aWeight !== bWeight) {
        return aWeight > bWeight;
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
            score: (context.pairWeightsMap.get(createPairKey(pair)) || 0) + result.score,
            sitOut: result.sitOut,
        };

        if (isBetterPairing(candidate, best, context.memberWeightsMap)) {
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
    pairWeightsMap: createPairWeightsMap<T, P>(previousSessions),
    memberWeightsMap: createMemberWeightsMap<T, P>(previousSessions),
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

interface PairingPlanInput {
    teamMembers: TeamMember[],
    vacations: Vacation[],
    previousPairSessions: Pick<PairSession, 'id' | 'members' | 'date'>[],
    // Sessions to leave out of the history
    ignoredSessionIds: string[],
    now: Date,
}

/**
 * Builds the plan for the week: the pairs, who is left without a pair and who is on vacation
 * @param input
 */
export const buildPairingPlan = (input: PairingPlanInput): PairingPlan => {
    const {
        teamMembers,
        vacations,
        previousPairSessions,
        ignoredSessionIds,
        now,
    } = input;

    const available = getAvailableTeamMembers(teamMembers, vacations, now);
    const availableIds = new Set(available.map((member) => member.id));
    const history = previousPairSessions
        .filter((session) => !ignoredSessionIds.includes(session.id))
        .map((session) => ({ ...session, weight: getSessionWeight(session.date, now) }));
    const pairs = generatePairProgrammingSessions(available, history);
    const pairedIds = new Set(pairs.flat().map((member) => member.id));

    return {
        pairs,
        unpaired: available.filter((member) => !pairedIds.has(member.id)),
        onVacation: teamMembers.filter((member) => !availableIds.has(member.id)),
    };
};

/**
 * Returns the pairing plan for the current week
 * @param now
 * @param ignoredSessionIds sessions to leave out of the history
 */
export const getPairingPlan = async (now: Date, ignoredSessionIds: string[]): Promise<PairingPlan> => {
    const teamMembers = await getTeamMembers();
    const vacations = await getVacations(now);
    const previousPairSessions = await getPreviousPairSessions(now);

    return buildPairingPlan({
        teamMembers,
        vacations,
        previousPairSessions,
        ignoredSessionIds,
        now,
    });
};
