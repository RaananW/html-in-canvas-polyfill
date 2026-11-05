// The Underglass GPU runtime presenting Strata controls through the
// HTML-in-Canvas API. window.underglass is the test hook.
import { createCanvasHosts, mountApplicationModule } from '@underglass/core';

const status = document.getElementById('status');
let clicks = 0;

const controller = mountApplicationModule(
  {
    ...createCanvasHosts(document.getElementById('frame')),
    budgets: { layers: 4, pixels: 4_000_000 },
    onStatusChange: (value) => {
      status.textContent = `${value.mode}: ${value.reason}`;
    },
  },
  {
    mount({ container, enroll }) {
      const panel = document.createElement('section');
      panel.id = 'panel';
      panel.setAttribute('drawable', '');
      panel.setAttribute('aria-label', 'Settings');
      panel.setAttribute('data-strata-scope', '');
      panel.innerHTML = `
        <div class="row">
          <button id="save" type="button" class="ug-button ug-button--accent" data-strata-face="raised"><span class="ug-button__label">Save</span></button>
          <button type="button" class="ug-button" data-strata-face="raised"><span class="ug-button__label">Cancel</span></button>
          <span class="ug-badge ug-badge--success" data-strata-face="flat">Active</span>
        </div>
        <label class="ug-switch"><input class="ug-switch__input" data-strata-face="well" type="checkbox" role="switch" checked><span class="ug-switch__knob" data-strata-face="knob" aria-hidden="true"></span><span class="ug-switch__label">Wi-Fi</span></label>
        <input class="ug-text-field" data-strata-face="well" type="email" aria-label="Email" value="ada@example.com">
        <progress class="ug-progress" data-strata-face="groove" value="40" max="100" aria-label="Upload"></progress>`;
      panel.querySelector('#save').addEventListener('click', () => clicks++);
      container.append(panel);
      const release = enroll({ id: 'panel', element: panel, layout: {}, transform: {} });
      return () => {
        release();
        container.replaceChildren();
      };
    },
  },
);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
async function settle() {
  await controller.settle();
  for (let i = 0; i < 4; i++) await nextFrame();
}

window.underglass = {
  ready: controller.enable().then(settle),
  settle,
  state: () => {
    const { mode, reason } = controller.state();
    return { mode, reason };
  },
  clicks: () => clicks,
};
