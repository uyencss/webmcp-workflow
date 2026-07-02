function writeJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printValidation(stdout, validation) {
  if (validation.errors.length === 0 && validation.warnings.length === 0) {
    stdout.write('Validation: ok\n');
    return;
  }
  if (validation.errors.length > 0) {
    stdout.write(`Validation errors (${validation.errors.length}):\n`);
    for (const error of validation.errors) stdout.write(`  - ${error}\n`);
  }
  if (validation.warnings.length > 0) {
    stdout.write(`Validation warnings (${validation.warnings.length}):\n`);
    for (const warning of validation.warnings) stdout.write(`  - ${warning}\n`);
  }
}

function printDryRun(stdout, report) {
  stdout.write(`Loaded: ${report.workflowFile}\n\n`);
  stdout.write(`Workflow: ${report.workflow.name} (${report.workflow.id})\n`);
  stdout.write(`Version: ${report.workflow.version}\n`);
  stdout.write(`Gateway: ${report.gateway.name || report.gateway.apiUrl}\n`);
  stdout.write(`Profile: ${report.profile.profileAlias || report.profile.profileId || '(auto/single profile)'}\n`);
  if (report.playbook) {
    if (report.playbook.path) {
      stdout.write(`Playbook: ${report.playbook.path} (${report.playbook.exists ? 'found' : 'MISSING'}, ${report.playbook.source})\n`);
    } else {
      stdout.write('Playbook: none\n');
    }
  }
  stdout.write(`Steps: ${report.steps.length}\n`);
  stdout.write(`Default timeout: ${report.settings.defaultTimeout}ms\n\n`);
  printValidation(stdout, report.validation);

  stdout.write('\nSteps:\n');
  for (let i = 0; i < report.steps.length; i++) {
    const step = report.steps[i];
    const kind = step.strategy ? `strategy:${step.strategy}` : `command:${step.command}`;
    stdout.write(`  ${i + 1}. [${step.id}] ${kind} critical=${step.critical} timeout=${step.timeoutMs}ms\n`);
    if (step.action) stdout.write(`     action=${step.action}\n`);
    if (step.captureAs) stdout.write(`     captureAs=${step.captureAs}\n`);
    if (step.wait) stdout.write(`     wait=${step.wait.type}:${step.wait.ms}ms\n`);
    if (step.onSuccess) stdout.write(`     onSuccess -> ${step.onSuccess}\n`);
    if (step.onFailure) stdout.write(`     onFailure -> ${JSON.stringify(step.onFailure)}\n`);
  }

  stdout.write('\nCommands:\n');
  for (const command of report.commands) {
    const status = command.unsupported ? 'unsupported' : (command.known ? command.group : 'unknown');
    stdout.write(`  - ${command.name}: ${status}\n`);
    if (command.reason) stdout.write(`    ${command.reason}\n`);
  }

  stdout.write('\nRoutes:\n');
  if (report.routes.length === 0) stdout.write('  - sequential only\n');
  else for (const route of report.routes) stdout.write(`  - ${route.from} --${route.type}--> ${route.to}\n`);

  stdout.write('\nTemplate refs:\n');
  if (report.templateRefs.length === 0) stdout.write('  - none\n');
  else for (const ref of report.templateRefs) stdout.write(`  - {{${ref}}}\n`);

  stdout.write('\nDry run complete. No commands were sent.\n');
}

function printList(stdout, workflows) {
  if (workflows.length === 0) {
    stdout.write('No workflows configured.\n');
    return;
  }
  for (const workflow of workflows) {
    const schedule = workflow.scheduled ? 'scheduled' : 'manual';
    stdout.write(`${workflow.id}\t${workflow.gateway}\t${workflow.profile || '-'}\t${schedule}\t${workflow.path}\n`);
    if (workflow.description) stdout.write(`  ${workflow.description}\n`);
  }
}

function printProfiles(stdout, result) {
  const profiles = result.health.profileDetails || (result.health.profiles || []).map((profileId) => ({ profileId }));
  if (profiles.length === 0) {
    stdout.write('No profiles connected.\n');
    return;
  }
  for (const profile of profiles) {
    const id = profile.profileId || profile.id;
    const label = profile.name || profile.email || '';
    stdout.write(label ? `${id}\t${label}\n` : `${id}\n`);
  }
}

function printDoctor(stdout, result) {
  stdout.write(`Gateway: ${result.gateway.name || result.gateway.apiUrl}\n`);
  stdout.write(`API: ${result.gateway.apiUrl}\n`);
  stdout.write(`Health: ${result.gateway.healthUrl}\n`);
  stdout.write(`Extension connected: ${Boolean(result.health.extensionConnected)}\n`);
  stdout.write(`Profiles: ${result.health.profileCount || 0}\n`);
  if (result.profile?.profileId) {
    stdout.write(`Selected profile: ${result.profile.profileAlias || result.profile.profileId} (${result.profile.profileId})\n`);
  } else {
    stdout.write('Selected profile: auto/single profile\n');
  }
  stdout.write(`Ping: ${result.ok ? 'ok' : `failed (${result.pingError.code})`}\n`);
  if (result.pingError) stdout.write(`Error: ${result.pingError.message}\n`);
}

module.exports = {
  printDoctor,
  printDryRun,
  printList,
  printProfiles,
  printValidation,
  writeJson,
};
