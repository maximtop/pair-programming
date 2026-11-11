export interface TeamMember {
    id: string;
    name: string;
    slack: string;
}

export type Pair<T extends BaseTeamMember> = [T, T];

export interface BaseTeamMember {
    id: string;
}

export interface PairingPlan {
    pairs: Pair<TeamMember>[];
    // Available members left without a pair (one member when the available count is odd)
    unpaired: TeamMember[];
    // Members skipped because they are on vacation for most of the working days of the week
    onVacation: TeamMember[];
}
