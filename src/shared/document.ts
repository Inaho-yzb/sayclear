import { sectionTitles, type Project } from './model'

export function toMarkdown(project: Project): string {
  const confirmed = project.sections.filter((section) => section.confirmed).length
  return [
    `# ${project.name.replace(/[\r\n]/g, ' ')} · 需求文档`,
    '',
    `版本：v0.${project.revision}  `,
    `状态：${confirmed === project.sections.length ? '已确认' : '草稿'}（${confirmed}/${project.sections.length} 章节已确认）  `,
    `更新时间：${project.updatedAt}`,
    '',
    ...project.sections.flatMap((section, index) => [
      `## ${index + 1}. ${sectionTitles[section.id]}`,
      '',
      `> ${section.confirmed ? '已确认' : '待确认'}`,
      '',
      section.content || '（待补充）',
      '',
    ]),
  ].join('\n')
}
