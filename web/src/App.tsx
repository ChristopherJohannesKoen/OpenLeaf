import { useApp } from './app/context';
import { useRoute } from './lib/router';
import { Library } from './screens/Library';
import { Modules } from './screens/Modules';
import { SignIn } from './screens/SignIn';
import { WorkspaceScreen } from './screens/Workspace';

export function App() {
  const { user } = useApp();
  const route = useRoute();
  if (!user) return <SignIn />;
  if (route.name === 'project') return <WorkspaceScreen key={route.id} id={route.id} />;
  if (route.name === 'modules') return <Modules />;
  return <Library />;
}
