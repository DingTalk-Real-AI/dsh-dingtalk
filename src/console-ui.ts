import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

import type { SelectOption, SetupUi } from './setup.js'

export class ConsoleSetupUi implements SetupUi {
  private readonly readline: Interface | undefined
  private readonly pipedAnswers: string[] | undefined

  constructor() {
    if (stdin.isTTY) this.readline = createInterface({ input: stdin, output: stdout })
    else this.pipedAnswers = readFileSync(0, 'utf8').split(/\r?\n/)
  }

  private async ask(prompt: string): Promise<string> {
    if (this.readline) return this.readline.question(prompt)
    stdout.write(prompt)
    return this.pipedAnswers?.shift() ?? ''
  }

  note(message: string): void {
    console.log(message)
  }

  warn(message: string): void {
    console.warn(`⚠️ ${message}`)
  }

  success(message: string): void {
    console.log(`✅ ${message}`)
  }

  loading(message: string): (succeeded: boolean, completedMessage: string) => void {
    console.log(`⏳ ${message}`)
    return (succeeded, completedMessage) => console.log(`${succeeded ? '✅' : '❌'} ${completedMessage}`)
  }

  async confirm(_id: string, message: string, initial: boolean): Promise<boolean> {
    const answer = (await this.ask(`${message} ${initial ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase()
    if (!answer) return initial
    return answer === 'y' || answer === 'yes' || answer === '是'
  }

  async select<T extends string>(
    _id: string,
    message: string,
    options: readonly SelectOption<T>[],
    initial: T,
  ): Promise<T> {
    console.log(`\n${message}`)
    options.forEach((option, index) =>
      console.log(`  ${index + 1}. ${option.label}${option.value === initial ? '（默认）' : ''}`),
    )
    while (true) {
      const answer = (await this.ask('请选择序号，直接回车使用默认值：')).trim()
      if (!answer) return initial
      const index = Number(answer) - 1
      if (Number.isInteger(index) && options[index]) return options[index].value
      const value = options.find((option) => option.value === answer)?.value
      if (value) return value
      this.warn('无效选择，请重新输入。')
    }
  }

  async text(_id: string, message: string): Promise<string> {
    while (true) {
      const value = (await this.ask(`${message}：`)).trim()
      if (value) return value
      this.warn('该值不能为空。')
    }
  }

  async optionalText(_id: string, message: string, initial = ''): Promise<string> {
    const suffix = initial ? `（当前：${initial}，直接回车保留）` : ''
    const value = (await this.ask(`${message}${suffix}：`)).trim()
    return value || initial
  }

  async secret(_id: string, message: string): Promise<string> {
    const hide = stdin.isTTY && stdout.isTTY && process.platform !== 'win32'
    if (hide) spawnSync('stty', ['-echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
    try {
      while (true) {
        const value = (await this.ask(`${message}：`)).trim()
        if (hide) stdout.write('\n')
        if (value) return value
        this.warn('该值不能为空。')
      }
    } finally {
      if (hide) spawnSync('stty', ['echo'], { stdio: ['inherit', 'ignore', 'ignore'] })
    }
  }

  close(): void {
    this.readline?.close()
  }
}
