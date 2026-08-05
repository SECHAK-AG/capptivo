/**
 * Capture frame rates — fixed, not user-tunable.
 *
 * Screen is always 60 so a 60 fps export is real (not duplicated 30 fps
 * frames). Export is where the user picks 30 or 60. Face-cam stays at 30:
 * webcams rarely deliver stable 60 fps
 */

export const SCREEN_CAPTURE_FPS = 60 as const;

export const CAMERA_CAPTURE_FPS = 30 as const;
