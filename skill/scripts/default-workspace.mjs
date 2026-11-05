// Default practice workspace in the user's home folder. Kept free of heavy imports so start.mjs
// can resolve it before checking the Node version.
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';

export const DEFAULT_WORKSPACE_NAME='motion-stage-workspace';
// Name used before the MotionStage rename (2.x). An existing one keeps opening.
export const LEGACY_WORKSPACE_NAME='motion-feedback-workspace';

export function defaultWorkspace(home=homedir(),exists=existsSync){
 const current=join(home,DEFAULT_WORKSPACE_NAME),legacy=join(home,LEGACY_WORKSPACE_NAME);
 return !exists(join(current,'project.json'))&&exists(join(legacy,'project.json'))?legacy:current;
}
