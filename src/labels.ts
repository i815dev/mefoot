import type { Sport } from './types';

export const sportLabel: Record<Sport, string> = {
  football: '축구',
  futsal: '풋살',
  both: '축구·풋살',
};

export function errorMessage(code: string): string {
  const map: Record<string, string> = {
    not_found: 'API에 아직 연결되지 않았거나 찾을 수 없어요.',
    api_unavailable: '서버에 잠시 연결할 수 없어요.',
    api_configuration_invalid: 'API 설정이 아직 완료되지 않았어요.',
    authentication_required: '로그인이 필요해요.',
    registration_required: '가입을 이어갈 정보가 없어요. 다시 로그인해 주세요.',
    registration_expired: '가입 시간이 지났어요. 다시 로그인해 주세요.',
    provider_not_configured: '이 로그인 방법은 아직 준비 중이에요.',
    team_not_found: '팀을 찾을 수 없어요.',
    join_requests_closed: '지금은 새 가입 신청을 받지 않아요.',
    team_archived: '보관된 팀이에요.',
    request_already_resolved: '이미 처리된 신청이에요.',
    owner_transfer_required: '대표는 권한을 넘긴 뒤에 탈퇴할 수 있어요.',
    team_admin_required: '대표·운영진만 할 수 있어요.',
    invalid_origin: '요청 출처가 맞지 않아요.',
  };
  return map[code] ?? `문제가 생겼어요 (${code})`;
}
