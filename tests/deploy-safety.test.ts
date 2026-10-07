import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const containerApp = readFileSync(new URL('../.github/containerapp.yaml', import.meta.url), 'utf8');
const serverIndex = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8');
const startScript = readFileSync(new URL('../scripts/start.sh', import.meta.url), 'utf8');
const packageManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('deployment rollback safety', () => {
  it('pins the requested English Relay voice while keeping Portuguese independently localized', () => {
    expect(workflow).toContain('CR_TTS_VOICE: SA7eD52NRr8WAehitVt1');
    expect(workflow).toContain('CR_TTS_VOICE_PT_BR: ${{ vars.CR_TTS_VOICE_PT_BR }}');
    expect(containerApp).toContain('value: "${CR_TTS_VOICE}"');
  });

  it('requires the semantic interpreter key before deploying conversational voice games', () => {
    expect(workflow).toContain('OPENAI_API_KEY is required for conversational voice commands in all six production games.');
    expect(workflow.match(/"openai-api-key=\$\{OPENAI_API_KEY:-disabled\}"/g)).toHaveLength(2);
    expect(containerApp).toContain('secretRef: openai-api-key');
    expect(serverIndex).toContain("throw new Error('OPENAI_API_KEY is required in production for conversational voice commands')");
  });

  it('keeps CI independent of Git LFS and verifies the private asset mirror before ACR build', () => {
    expect(ci).not.toMatch(/\blfs:\s*true\b/);
    expect(workflow).not.toMatch(/\blfs:\s*true\b/);
    expect(ci).toContain('npm run verify:fighter-asset-pointers');
    expect(workflow).toContain('FIGHTER_ASSET_CONTAINER: fighter-build-assets');
    expect(workflow).toContain('az storage container set-permission');
    expect(workflow).toContain('az storage blob download');
    expect(workflow).toContain('node tools/verify-lfs-assets.mjs --print-bundle-id');
    expect(workflow).toContain('--name "$ASSET_BUNDLE/$file"');
    expect(workflow).toContain('--asset-root "$ASSET_DOWNLOAD_ROOT/$ASSET_BUNDLE"');
    expect(workflow).toContain('--exact');
    expect(workflow).toContain('npm run verify:fighter-assets');
    expect(workflow.indexOf('npm run verify:fighter-assets'))
      .toBeLessThan(workflow.indexOf('az acr build'));
  });

  it('masks generated registry credentials before exporting them', () => {
    const credentials = workflow.slice(
      workflow.indexOf('- name: Get ACR credentials'),
      workflow.indexOf('- name: Set app secrets'),
    );
    expect(credentials).toContain('echo "::add-mask::$acr_password"');
    expect(credentials.indexOf('acr_password=$(az acr credential show'))
      .toBeLessThan(credentials.indexOf('echo "::add-mask::$acr_password"'));
    expect(credentials.indexOf('echo "::add-mask::$acr_password"'))
      .toBeLessThan(credentials.indexOf('>> "$GITHUB_OUTPUT"'));
  });

  it('preserves false when checking whether revisions are inactive', () => {
    expect(workflow).not.toContain('.properties.active // ""');
    expect(workflow).toContain(
      '.properties.active | if . == null then "" else tostring end',
    );
  });

  it('identifies the candidate by its ACA revision name', () => {
    expect(workflow).toContain(
      '[ "$NEW_REVISION" = "${APP_NAME}--${REVISION_SUFFIX}" ]',
    );
    expect(workflow).not.toContain('ACTUAL_SUFFIX');
  });

  it('arms first-create cleanup before creating a serving revision', () => {
    const createBranch = workflow.slice(
      workflow.indexOf('echo "Creating new container app (minimal, tagged)..."'),
      workflow.indexOf('echo "Setting secrets on the new app..."'),
    );
    expect(createBranch.indexOf('trap rollback_on_error ERR'))
      .toBeLessThan(createBranch.indexOf('az containerapp create'));
    expect(createBranch).toContain('--min-replicas 0 --max-replicas 1');
    expect(workflow).toContain('Container App was not created; rollback has nothing to stop or restore.');
  });

  it('snapshots stopped persistent data and restores it before old code starts', () => {
    expect(workflow).toContain('create_data_snapshot');
    expect(workflow).toContain('az storage share snapshot');
    expect(workflow).toContain('az storage file download-batch');
    expect(workflow).toContain('az storage file delete-batch');
    expect(workflow).toContain('az storage file upload-batch');
    expect(workflow).toContain('diff --recursive --brief');
    const rollback = workflow.slice(
      workflow.indexOf('rollback_previous_revisions()'),
      workflow.indexOf('rollback_on_error()'),
    );
    expect(rollback.indexOf('restore_data_snapshot'))
      .toBeLessThan(rollback.indexOf('az containerapp revision activate'));
    expect(rollback).toContain('--revision-weight "${previous}=100"');
    expect(rollback).not.toContain('--mode single');
    expect(rollback).toContain('Could not inventory revisions; refusing automatic data restore');
    expect(rollback).toContain('Could not read latest revision; refusing automatic data restore');
    expect(rollback).toContain('if [ "$DATA_RESTORE_SAFE" != "true" ]');
    expect(workflow.indexOf('DATA_RESTORE_SAFE=false\n          aca_write_retry az containerapp ingress traffic set'))
      .toBeGreaterThan(-1);
    const oldTrafficPin = workflow.indexOf('--revision-weight "${OLD_REVISIONS[0]}=100"');
    const oldDeactivation = workflow.indexOf('for revision in "${OLD_REVISIONS[@]}"; do', oldTrafficPin);
    expect(oldTrafficPin).toBeGreaterThan(-1);
    expect(oldTrafficPin).toBeLessThan(oldDeactivation);
  });

  it('verifies exact mount type, path, and health probe settings', () => {
    expect(workflow).toContain('appdata:appdata:AzureFile');
    expect(workflow).toContain('appdata:/app/appdata');
    expect(workflow).toContain('Liveness:/livez:8080:HTTP:15:15:3:5');
    expect(workflow).toContain('Readiness:/livez:8080:HTTP:0:5:3:5');
    expect(workflow).toContain('Startup:/livez:8080:HTTP:3:5:24:5');
    expect(workflow).toContain('--revision-weight "${NEW_REVISION}=100"');
    expect(workflow.indexOf('https://${REVISION_FQDN}${route}'))
      .toBeLessThan(workflow.indexOf('--revision-weight "${NEW_REVISION}=100"'));
  });

  it('validates Trivia and smokes both Trivia and Chess before publishing their URLs', () => {
    expect(packageManifest.scripts['validate:trivia-bank']).toBe('tsx tools/validate-trivia-bank.ts');
    expect(packageManifest.scripts['smoke:trivia']).toBe('node tools/smoke-trivia.mjs');
    expect(workflow).toContain('npm run validate:trivia-bank');
    expect(workflow).toContain('/karaoke.html /trivia.html /chess.html /analytics');
    expect(workflow).toContain('Voice Trivia:   https://${FQDN}/trivia.html');
    expect(workflow).toContain('Voice Chess:    https://${FQDN}/chess.html');
    expect(workflow.indexOf('https://${REVISION_FQDN}${route}'))
      .toBeLessThan(workflow.indexOf('--revision-weight "${NEW_REVISION}=100"'));
  });

  it('documents both mutable Trivia files on persistent storage', () => {
    expect(startScript).toContain('data/trivia-questions.json');
    expect(startScript).toContain('data/trivia-leaderboard.json');
    expect(workflow).toContain('data/trivia-questions.json');
    expect(workflow).toContain('data/trivia-leaderboard.json');
  });

  it('declares and provisions the Dub secret before referencing it', () => {
    expect(containerApp).toContain('- name: dub-api-key');
    expect(containerApp).toContain('secretRef: dub-api-key');
    expect(containerApp).toContain('secretRef: dub-folder-id');
    expect(workflow).toContain('"dub-api-key=${DUB_API_KEY:-disabled}"');
    expect(workflow).toContain('"dub-folder-id=${DUB_FOLDER_ID:-disabled}"');
    expect(workflow).toContain('DUB_API_KEY and DUB_SHORT_DOMAIN must be configured together.');
  });

  it('fails closed and wires required Karaoke credentials and calibration in both deploy branches', () => {
    expect(containerApp).toContain('- name: deepgram-api-key');
    expect(containerApp).toContain('secretRef: deepgram-api-key');
    expect(containerApp).toContain('secretRef: editor-token');
    expect(containerApp).toMatch(/name: KARAOKE_CALIBRATION_OFFSET_MS\s+value: "\$\{KARAOKE_CALIBRATION_OFFSET_MS\}"/);
    expect(workflow).toContain('DEEPGRAM_API_KEY is required while Voice Karaoke is enabled by default.');
    expect(workflow).toContain('EDITOR_TOKEN must contain at least 16 characters');
    expect(workflow.match(/"deepgram-api-key=\$\{DEEPGRAM_API_KEY:-disabled\}"/g)).toHaveLength(2);
    expect(workflow).toContain('"editor-token=$EDITOR_TOKEN"');
    expect(workflow).toContain('"editor-token=${EDITOR_TOKEN:-}"');
    expect(workflow).toContain('KARAOKE_CALIBRATION_OFFSET_MS: ${{ vars.KARAOKE_CALIBRATION_OFFSET_MS }}');
    expect(workflow).toContain("${KARAOKE_CALIBRATION_OFFSET_MS}");
    expect(serverIndex).toContain('process.env.KARAOKE_CALIBRATION_OFFSET_MS || 0');
  });

  it('provisions the optional analytics PIN as a Container App secret', () => {
    expect(containerApp).toContain('- name: analytics-admin-pin');
    expect(containerApp).toContain('secretRef: analytics-admin-pin');
    expect(workflow).toContain('ANALYTICS_ADMIN_PIN: ${{ secrets.ANALYTICS_ADMIN_PIN }}');
    expect(workflow).toContain('"analytics-admin-pin=${ANALYTICS_ADMIN_PIN:-disabled}"');
    expect(workflow).toContain('Production operator access requires Google OAuth or ANALYTICS_ADMIN_PIN.');
    expect(workflow).toContain('EXPECTED_CODE=$([ "$route" = "/operator" ]');
    expect(workflow).toContain('ANALYTICS_ADMIN_PIN cannot be \'disabled\' or whitespace only.');
    expect(workflow).toContain('Google OAuth credentials cannot be \'disabled\' or whitespace only.');
    expect(workflow).toContain('"https://${REVISION_FQDN}/analytics?returnTo=%2Foperator"');
  });

  it('keeps production standalone game calls enabled', () => {
    expect(containerApp).toMatch(/name: ARCADE_STANDALONE_VOICE_ENABLED\s+value: "true"/);
  });

  it('keeps the deterministic Arcade signing fallback out of production', () => {
    expect(serverIndex).toContain("process.env.NODE_ENV === 'production' ? undefined : '0'.repeat(64)");
    expect(serverIndex).toContain('process.env.ARCADE_SIGNING_SECRET ?? localArcadeSigningSecret');
  });
});
