import type { Status } from './bridge-data';
import { tf } from './core/i18n';

const REASONS: Record<string, [string, string]> = {
	module_disabled: ['reason_module_disabled', 'Module is disabled in the root manager'],
	turned_off: ['reason_turned_off', 'Turned off in settings'],
	va_stopped: ['reason_va_stopped', 'VirtualAP is not running'],
	va_routed: ['reason_va_routed', 'VirtualAP is in routed mode (the phone is already the gateway there)'],
	bad_gateway: ['reason_bad_gateway', "VirtualAP's gateway address is missing or invalid"],
	waiting_bridge: ['reason_waiting_bridge', 'Waiting for {arg}'],
	host_is_gateway: ['reason_host_is_gateway', "Phone address {arg} is the gateway's address; pick another"],
	addr_failed: ['reason_addr_failed', 'Could not add {arg} to the bridge'],
	rule_failed: ['reason_rule_failed', 'Could not add the IPv4 routing rule'],
	ipv6_unavailable: ['reason_ipv6_unavailable', 'IPv6 is not available on {arg}'],
};

export function reasonText(s: Status): string {
	const entry = REASONS[s.reason_code];
	if (!entry) return s.reason;
	return tf(entry[0], entry[1], { arg: s.reason_arg });
}
