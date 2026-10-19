'use client';

import { useId, useState } from 'react';
import { CODEX_MODELS, gatewayModelId } from '../shared/model-catalog';

type Props = {
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  inherit?: boolean;
  testProvider?: boolean;
  provider?: string;
};

const modelId = (id: string, provider: string) => provider === 'openai' ? id : gatewayModelId(id);
const knownModel = (value: string, provider: string) => CODEX_MODELS.some(model => modelId(model.id, provider) === value);

export function ModelPicker({label = 'Модель', value, defaultValue = '', onChange, inherit = false, testProvider = false, provider = 'gateway'}: Props) {
  const id = useId();
  const [localValue, setLocalValue] = useState(defaultValue);
  const current = value ?? localValue;
  const [custom, setCustom] = useState(() => !!(value ?? defaultValue) && !knownModel(value ?? defaultValue, provider));
  const change = (next: string) => { setLocalValue(next); onChange?.(next); };

  return <div className="field">
    <input type="hidden" name="model" value={current}/>
    <label htmlFor={id}>{label}</label>
    <select id={id} value={custom ? '__custom__' : current} aria-describedby={`${id}-hint`}
      onChange={event => {
        const next = event.target.value;
        setCustom(next === '__custom__');
        change(next === '__custom__' ? (knownModel(current, provider) ? '' : current) : next);
      }}>
      <option value="">{inherit ? 'Наследовать общую модель' : 'Выберите модель'}</option>
      <optgroup label="Модели Codex · OpenAI">
        {CODEX_MODELS.map(model => <option key={model.id} value={modelId(model.id, provider)} disabled={testProvider}>{model.name}</option>)}
      </optgroup>
      <option value="__custom__">Другой идентификатор / текущая модель</option>
    </select>
    {custom && <>
      <label htmlFor={`${id}-custom`}>Идентификатор модели</label>
      <input id={`${id}-custom`} value={current} onChange={event => change(event.target.value)}
        placeholder={testProvider ? 'test/model' : provider === 'openai' ? 'gpt-6-luna' : 'provider/model'} maxLength={160} aria-describedby={`${id}-hint`}/>
    </>}
    <small id={`${id}-hint`}>{testProvider
      ? 'Сейчас выбран тестовый провайдер. Для моделей Codex выберите рабочее подключение в настройках.'
      : `${inherit ? 'Можно наследовать общую модель. ' : ''}Список из Codex; доступ через ${provider === 'openai' ? 'OpenAI API' : 'AI Gateway'} подтверждается кнопкой проверки модели.`}</small>
  </div>;
}
