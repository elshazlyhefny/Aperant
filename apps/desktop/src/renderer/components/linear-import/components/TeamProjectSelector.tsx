/**
 * Team and project selection dropdowns
 */

import { useTranslation } from 'react-i18next';
import { Label } from '../../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../../ui/select';
import type { LinearTeam, LinearProject } from '../types';

interface TeamProjectSelectorProps {
  teams: LinearTeam[];
  projects: LinearProject[];
  selectedTeamId: string;
  selectedProjectId: string;
  isLoadingTeams: boolean;
  isLoadingProjects: boolean;
  onTeamChange: (teamId: string) => void;
  onProjectChange: (projectId: string) => void;
}

export function TeamProjectSelector({
  teams,
  projects,
  selectedTeamId,
  selectedProjectId,
  isLoadingTeams,
  isLoadingProjects,
  onTeamChange,
  onProjectChange
}: TeamProjectSelectorProps) {
  const { t } = useTranslation('linear');
  return (
    <div className="flex gap-4 shrink-0">
      <div className="flex-1 space-y-2">
        <Label htmlFor="linear-team-select" className="text-sm font-medium text-foreground">
          {t('import.team.label')}
        </Label>
        <Select
          value={selectedTeamId}
          onValueChange={onTeamChange}
          disabled={isLoadingTeams}
        >
          <SelectTrigger id="linear-team-select">
            <SelectValue placeholder={isLoadingTeams ? t('import.team.loading') : t('import.team.placeholder')} />
          </SelectTrigger>
          <SelectContent>
            {teams.map(team => (
              <SelectItem key={team.id} value={team.id}>
                {team.name} ({team.key})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 space-y-2">
        <Label htmlFor="linear-project-select" className="text-sm font-medium text-foreground">
          {t('import.project.label')}
        </Label>
        <Select
          value={selectedProjectId || '__all__'}
          onValueChange={(value) => onProjectChange(value === '__all__' ? '' : value)}
          disabled={isLoadingProjects || !selectedTeamId}
        >
          <SelectTrigger id="linear-project-select">
            <SelectValue placeholder={isLoadingProjects ? t('import.team.loading') : t('import.project.placeholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('import.project.all')}</SelectItem>
            {projects.map(project => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
