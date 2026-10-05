// A hash router: #/ (Library), #/p/<project id>, #/modules. Nothing to configure on a static host.
import { useEffect, useState } from 'react';

export type Route =
  | { name: 'library' }
  | { name: 'project'; id: string }
  | { name: 'modules' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '');
  const [first, second] = path.split('/');
  if (first === 'p' && second) return { name: 'project', id: decodeURIComponent(second) };
  if (first === 'modules') return { name: 'modules' };
  return { name: 'library' };
}

export function hrefFor(route: Route): string {
  if (route.name === 'project') return `#/p/${encodeURIComponent(route.id)}`;
  if (route.name === 'modules') return '#/modules';
  return '#/';
}

export function go(route: Route): void {
  window.location.hash = hrefFor(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
