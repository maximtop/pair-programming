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

// Initializing a client
const notion = new Client({
    auth: process.env.NOTION_API_KEY, // or your API key as a string
});

const NOTION_QUERY_ATTEMPTS = 4;
const NOTION_QUERY_RETRY_DELAY_MS = 1000;

const RETRYABLE_NOTION_ERROR_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    // The request timeout of the Notion client
    'notionhq_client_request_timeout',
]);

interface ErrorWithDetails {
    code?: string;
    message?: string;
    status?: number;
    // Built-in fetch rejects with `TypeError: fetch failed` and keeps the network error here
    cause?: { code?: string };
}

interface NotionRetryOptions {
    attempts?: number;
    getDelayMs?: (attempt: number) => number;
    sleep?: (delayMs: number) => Promise<void>;
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

    const code = errorDetails.code ?? errorDetails.cause?.code;

    if (code) {
        return code;
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

    const codes = [errorDetails.code, errorDetails.cause?.code];

    if (codes.some((code) => code !== undefined && RETRYABLE_NOTION_ERROR_CODES.has(code))) {
        return true;
    }

    return errorDetails.status !== undefined && (errorDetails.status === 429 || errorDetails.status >= 500);
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
    Date: 'Date',
    Status: 'Status',
};

/**
 * Maps a team members database page to a team member; blank fields become 'Unknown'
 * @param page
 */
export const parseTeamMember = (page: PageObjectResponse): TeamMember => {
    const nameProperty = page.properties[TeamMembersColumn.Name];
    const slackProperty = page.properties[TeamMembersColumn.Slack];

    const name = nameProperty?.type === 'title' && nameProperty.title.length > 0
        ? nameProperty.title[0].plain_text
        : 'Unknown';
    const slack = slackProperty?.type === 'rich_text' && slackProperty.rich_text.length > 0
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
    memberId: string;
    start: string;
    // Null for a single-day vacation
    end: string | null;
}

const VACATIONS_LOOKAHEAD_DAYS = 7;

/**
 * Builds the filter for vacations that start before a week from `now`.
 * There is deliberately no lower bound: ongoing vacations must be returned too.
 * `getAvailableTeamMembers` counts the days they take from the current week.
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
        .filter((block): block is PageObjectResponse => block.object === 'page')
        .map(parseVacation);
};

export interface PairSession {
    id: string;
    members: BaseTeamMember[];
    date: string;
}

/**
 * Maps a pair sessions database page to a pair session
 * @param page
 */
export const parsePairSession = (page: PageObjectResponse): PairSession => {
    const membersProperty = page.properties[PairSessionsColumn.TeamMembers];
    const dateProperty = page.properties[PairSessionsColumn.Date];

    if (membersProperty?.type !== 'relation' || dateProperty?.type !== 'date' || !dateProperty.date) {
        throw new Error(`Pair session ${page.id} has no "${PairSessionsColumn.TeamMembers}" relation or no date`);
    }

    return {
        id: page.id,
        members: membersProperty.relation.map((member) => ({ id: member.id })),
        date: dateProperty.date.start,
    };
};

/**
 * Returns all previous sessions until `now`
 * @param now
 */
const getPreviousPairSessions = async (now: Date): Promise<PairSession[]> => {
    const blocks = await queryDatabase({
        database_id: PAIR_SESSIONS_TABLE_ID,
        filter: {
            property: PairSessionsColumn.Date,
            date: {
                before: now.toISOString(),
            },
        },
    }, 'Query previous pair sessions');

    return blocks
        .filter((block): block is PageObjectResponse => block.object === 'page')
        .map(parsePairSession);
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

interface WeightedPairSession {
    id: string;
    members: BaseTeamMember[];
    // How much the session counts as a repeat; see `getSessionWeight`
    weight: number;
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
function createPairWeightsMap(previousSessions: WeightedPairSession[]): Map<string, number> {
    const weights = new Map<string, number>();
    previousSessions.forEach((session) => {
        const key = createPairKey(session.members);
        weights.set(key, (weights.get(key) || 0) + session.weight);
    });
    return weights;
}

/**
 * Creates a map with the total weight of the previous sessions each member took part in
 * @param previousSessions
 */
function createMemberWeightsMap(previousSessions: WeightedPairSession[]): Map<string, number> {
    const weights = new Map<string, number>();
    previousSessions.forEach((session) => {
        session.members.forEach((member) => {
            weights.set(member.id, (weights.get(member.id) || 0) + session.weight);
        });
    });
    return weights;
}

interface PairingResult<T extends BaseTeamMember> {
    pairs: Pair<T>[];
    score: number;
    // The member left without a pair when the number of members is odd
    sitOut?: T;
}

interface PairingContext<T extends BaseTeamMember> {
    pairWeightsMap: Map<string, number>;
    memberWeightsMap: Map<string, number>;
    cache: Map<string, PairingResult<T>>;
}

/**
 * Compares pairings: the lower repeat score wins.
 * On equal scores, the one whose sit-out member has the larger total weight of previous sessions wins,
 * then the one with the smaller id.
 * On ties this spreads the sit-outs instead of leaving out the first member every week.
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
 * Finds the pairing of `members` with the lowest total weight of the past sessions of its pairs.
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
export const generatePairProgrammingSessions = <T extends BaseTeamMember>(
    availableTeamMembers: T[],
    previousSessions: WeightedPairSession[],
): Pair<T>[] => findOptimalPairs(availableTeamMembers, {
    pairWeightsMap: createPairWeightsMap(previousSessions),
    memberWeightsMap: createMemberWeightsMap(previousSessions),
    cache: new Map(),
}).pairs;

const WORKING_DAYS_IN_WEEK = 5;

// A member on vacation for at least this many working days of the week gets no pair
const MIN_VACATION_DAYS_TO_SKIP_WEEK = 3;

/**
 * Returns the working days, Monday to Friday, of the week of `now` as `yyyy-MM-dd` in the local time zone
 * @param now
 */
const getWorkingDays = (now: Date): string[] => {
    const monday = startOfWeek(now, { weekStartsOn: 1 });
    return Array.from({ length: WORKING_DAYS_IN_WEEK }, (_, index) => format(addDays(monday, index), 'yyyy-MM-dd'));
};

/**
 * Whether the vacation covers the calendar day. Both ends are inclusive.
 * Only the date part of a Notion date value counts, so a vacation entered with a time
 * covers its first and last day in full.
 * @param vacation
 * @param day `yyyy-MM-dd`
 */
const coversDay = (vacation: Vacation, day: string): boolean => {
    const start = vacation.start.slice(0, 10);
    const end = (vacation.end ?? vacation.start).slice(0, 10);
    return start <= day && day <= end;
};

/**
 * Returns team members who get a pair in the week of `now`:
 * those on vacation for fewer than `MIN_VACATION_DAYS_TO_SKIP_WEEK` of its working days.
 * The whole week counts, whichever day the run happens on, and the days of several vacations add up.
 * @param teamMembers
 * @param vacations
 * @param now
 */
export const getAvailableTeamMembers = <T extends BaseTeamMember>(
    teamMembers: T[],
    vacations: Vacation[],
    now: Date,
): T[] => {
    const workingDays = getWorkingDays(now);

    return teamMembers.filter((teamMember) => {
        const memberVacations = vacations.filter((vacation) => vacation.memberId === teamMember.id);
        const vacationDays = workingDays.filter((day) => memberVacations.some((vacation) => coversDay(vacation, day)));
        return vacationDays.length < MIN_VACATION_DAYS_TO_SKIP_WEEK;
    });
};

interface PairingPlanInput {
    teamMembers: TeamMember[];
    vacations: Vacation[];
    previousPairSessions: PairSession[];
    // Sessions to leave out of the history
    ignoredSessionIds: string[];
    now: Date;
}

/**
 * Builds the plan for the week: the pairs, who is left without a pair
 * and who gets no pair because of a vacation
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
