/**
 * Ways in for models from other software: the `window.frameforge` JavaScript API, requests
 * from an embedding page by postMessage, and `?model=<url>` on the address.
 */
import { useEffect, useRef } from 'react';
import { importModelText, issueText } from '../import';
import type { ImportFormat } from '../import';
import type { Project3D } from '../model3d';
import { notify } from './toast';
import type { FrameForgeApi, ImportReport } from './api';
import {
  API_VERSION,
  createApi,
  fetchModelText,
  modelUrl,
  parseRequest,
  runRequest,
  withinSize,
} from './api';
import { useStore3D } from './store';
import type { ImportSource } from './ImportDialog';

declare global {
  interface Window {
    /** In-page API for embedding and automation (see docs/IMPORT.md). */
    frameforge?: FrameForgeApi;
  }
}

function importedMessage(report: ImportReport, from: string): string {
  const warn = report.warnings.length;
  return (
    `Imported "${report.name}" from ${from}: ${report.counts.nodes} nodes, ${report.counts.members} members` +
    (warn > 0 ? ` (${warn} warning${warn === 1 ? '' : 's'} — see Import for details).` : '.')
  );
}

export function ApiBridge3D() {
  const { state, dispatch } = useStore3D();
  const latest = useRef<Project3D>(state.project);
  useEffect(() => {
    latest.current = state.project;
  }, [state.project]);

  useEffect(() => {
    const host = (from: string) => ({
      getProject: () => latest.current,
      setProject: (project: Project3D, report: ImportReport) => {
        // Reads after this see the new model straight away, before React re-renders.
        latest.current = project;
        dispatch({ type: 'load', project });
        notify(importedMessage(report, from));
      },
    });
    const api = createApi(host('a script'));
    window.frameforge = api;

    const parent = window.parent !== window ? window.parent : null;
    const embedApi = createApi(host('the embedding page'));
    let embedderLoaded = false;
    const onMessage = (event: MessageEvent) => {
      // Only the page that frames FrameForge, or the one that opened it, may send requests.
      if (!event.source || (event.source !== parent && event.source !== window.opener)) return;
      const request = parseRequest(event.data);
      if (!request || !withinSize(event.data)) return;
      const { reply, loaded } = runRequest(embedApi, request, embedderLoaded);
      if (loaded) embedderLoaded = true;
      (event.source as Window).postMessage(reply, event.origin === 'null' ? '*' : event.origin);
    };
    window.addEventListener('message', onMessage);
    // Tell an embedding page that requests can be sent now (no model data in this message).
    parent?.postMessage({ frameforge: 'ready', version: API_VERSION }, '*');
    window.opener?.postMessage({ frameforge: 'ready', version: API_VERSION }, '*');
    return () => {
      window.removeEventListener('message', onMessage);
      if (window.frameforge === api) delete window.frameforge;
    };
  }, [dispatch]);
  return null;
}

/** Imports the model named by `?model=` once, then drops the parameter from the address. */
export function UrlModel3D({ onProblem }: { onProblem: (source: ImportSource) => void }) {
  const { dispatch } = useStore3D();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const param = params.get('model');
    if (!param) return;
    const forget = () => {
      params.delete('model');
      params.delete('format');
      const query = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
      );
    };
    const url = modelUrl(param, window.location.href);
    if (!url) {
      notify('?model= needs an https:// address (or a file on this site).', 'error');
      forget();
      return;
    }
    const format = params.get('format');
    notify(`Loading the model from ${url.host}…`);
    fetchModelText(url)
      .then((text) => {
        const result = importModelText(text, {
          filename: url.pathname,
          format:
            format === 'json' || format === 'csv' || format === 'std'
              ? (format as ImportFormat)
              : undefined,
        });
        forget();
        if (!result.project) {
          notify(
            `The model from ${url.host} has problems: ${result.errors.slice(0, 2).map(issueText).join(' ')}`,
            'error',
          );
          onProblem({ text, filename: url.pathname.split('/').pop() ?? '' });
          return;
        }
        dispatch({ type: 'load', project: result.project });
        const warn = result.warnings.length;
        notify(
          `Opened "${result.project.name}" from ${url.host}` +
            (warn > 0
              ? ` with ${warn} warning${warn === 1 ? '' : 's'}: ${issueText(result.warnings[0])}`
              : '.'),
        );
      })
      .catch((e: unknown) => {
        forget();
        notify(e instanceof Error ? e.message : 'Could not load the model.', 'error');
      });
  }, [dispatch, onProblem]);
  return null;
}
