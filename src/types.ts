export type Sport = 'football' | 'futsal' | 'both';
export type Intent = 'view' | 'follow' | 'join';
export type ProviderId = 'kakao' | 'google' | 'apple';

export type User = {
  id: string;
  display_name: string;
  status: string;
};

export type Team = {
  id: string;
  name: string;
  description: string | null;
  sport: Sport;
  region_label: string | null;
  logo_url: string | null;
  join_requests_open: boolean;
  created_at: string;
  updated_at: string;
};

export type Membership = {
  role: 'owner' | 'admin' | 'member';
  joined_at: string;
};

export type JoinRequest = {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  message: string | null;
  created_at: string;
  resolved_at?: string | null;
  resolution_note?: string | null;
};

export type TeamMe = {
  following: boolean;
  membership: Membership | null;
  join_request: JoinRequest | null;
};

export type TeamDetail = {
  team: Team;
  me: TeamMe | null;
};

export type Provider = {
  id: ProviderId;
  name: string;
  enabled: boolean;
};

export type PendingApplicant = {
  id: string;
  team_id: string;
  user_id: string;
  status: string;
  message: string | null;
  created_at: string;
  applicant: {
    id: string;
    display_name: string;
    avatar_url: string | null;
    status: string;
  };
};
