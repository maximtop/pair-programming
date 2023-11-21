export interface TeamMember {
    id: string;
    name: string;
    slack: string;
}

export type Pair<T extends BaseTeamMember> = [T, T];

export interface BaseTeamMember {
    id: string,
}
