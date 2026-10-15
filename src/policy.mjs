// One policy table for discovery and execution. UI visibility is never authorization.
export const PROFILES = ['core', 'interactive', 'legacy'];
export const INTERACTIVE_TOOLS = new Set(['start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions']);
const DC_READ = new Set(['read_file','read_multiple_files','list_directory','start_search','get_more_search_results','stop_search','list_searches','get_file_info','get_config','get_usage_stats','get_recent_tool_calls','list_processes','list_sessions','read_process_output']);
const DC_WRITE = new Set(['write_file','write_pdf','edit_block','create_directory','move_file']);
const DC_EXEC = new Set(['start_process','interact_with_process']);
export const LEGACY_TOOL_NAMES=new Set([...DC_READ,...DC_WRITE,...DC_EXEC,'force_terminate','kill_process','set_config_value','write_pdf','give_feedback_to_desktop_commander','get_prompts']);
const RECOVERY = new Set(['job_read','job_list','job_cancel','workspace_read','workspace_list','workspace_cancel']);

export function toolRequirements(name, args = {}, upstream = false) {
  if (upstream) {
    const result = ['desktopCommander'];
    if (DC_EXEC.has(name)) result.push('commandExecution', 'filesystemRead', 'filesystemWrite');
    else if (DC_WRITE.has(name)) result.push('filesystemWrite');
    else if (DC_READ.has(name)) result.push('filesystemRead');
    else if (!['force_terminate','kill_process'].includes(name)) result.push('commandExecution','filesystemRead','filesystemWrite');
    return result;
  }
  if (RECOVERY.has(name) || name === 'dev_get_guide') return [];
  if (name === 'job_input') return ['jobs','commandExecution','filesystemRead','filesystemWrite'];
  if (name === 'file_import') return ['fileTransfer','filesystemWrite'];
  if (name === 'file_unpack') return ['fileTransfer','filesystemRead','filesystemWrite'];
  if (name === 'file_export') return ['fileTransfer','filesystemRead'];
  if (name.startsWith('fs_') || name === 'workspace_review') return ['filesystemRead'];
  if (name === 'job_start') return ['jobs','commandExecution','filesystemRead','filesystemWrite'];
  if (name === 'workspace_execute') {
    const result = new Set(['workspace']);
    for (const step of Array.isArray(args.steps) ? args.steps : []) {
      if (['write','replace','mkdir','patch','copy','move'].includes(step.type)) result.add('filesystemWrite');
      if (['copy','move'].includes(step.type)) result.add('filesystemRead');
      if (step.type === 'patch' || step.type === 'replace') result.add('filesystemRead');
      if (['exec','container_build'].includes(step.type)) {
        for (const permission of ['commandExecution','filesystemRead','filesystemWrite']) result.add(permission);
      }
      if (step.type === 'container_build') result.add('containerBuild');
      if (step.type === 'http_check') result.add('commandExecution');
    }
    return [...result];
  }
  return [];
}

export function denialReason(settings, name, args = {}, upstream = false) {
  if (settings.blockedTools.includes(name)) return 'disabled by the administrator';
  const profile = settings.toolProfile ?? 'core';
  if (upstream && (profile === 'core' || (profile === 'interactive' && !INTERACTIVE_TOOLS.has(name)))) return 'not exposed by the selected tool profile';
  if (!upstream && name === 'job_input' && profile === 'core') return 'job_input requires interactive or legacy tool profile';
  for (const requirement of toolRequirements(name, args, upstream)) {
    if (settings.permissions[requirement] === false) return 'disabled by the administrator (' + requirement + ')';
  }
  return null;
}
