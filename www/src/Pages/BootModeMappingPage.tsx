import { Alert, Button, Col, Container, Form, NavItem, Row } from 'react-bootstrap';
import { memo, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import Section from '../Components/Section';
import {
	useBootModeStore,
	useBootModeStoreActions,
	NUM_PINS,
} from '../Store/useBootModesStore';
import { INPUT_MODE_OPTIONS, InputModeOptions } from '../Data/InputBootModes';
import { AppContext } from '../Contexts/AppContext';
import CustomSelect from '../Components/CustomSelect';
import { useTranslation } from 'react-i18next';
import { ActionMeta, MultiValue, SingleValue } from 'react-select';
import CaptureButton from '../Components/CaptureButton';
import useProfilesStore from '../Store/useProfilesStore';
import { InputMode } from '@proto/enums';
import { FieldArray, Formik, FormikProps, useField, useFormikContext } from 'formik';
import WebApi from '../Services/WebApi';
import { array, boolean, number, object, ObjectSchema } from 'yup';
import Select from 'react-select/dist/declarations/src/Select';
import set from 'lodash';

type PinOption = {
	label: string;
	value: number;
};

type ProfileOption = {
	label: string;
	value: number;
	disabled: boolean;
};

type BootModeMapping = {
	pins: number[];
	inputMode?: number;
	profileIndex?: number;
};

type FormState = {
	webConfigPins: number[];
	usbModePins: number[];
	bootModes: BootModeMapping[];
	enabled: boolean;
};

type APIResponseData = {
	webConfigPinMask: number;
	usbModePinMask: number;
	enabled: boolean;
	inputModeMappings: {
		pinMask: number;
		inputMode: number;
		// Profiles are 1-indexed. 0 = no mapped profile
		profileNumber: number;
	}[];
};

const MAX_INPUT_MODES = 8;

const GROUPED_OPTIONS = [
	{
		label: 'Primary',
		options: INPUT_MODE_OPTIONS.filter(({ group }) => group === 'primary'),
	},
	{
		label: 'Mini',
		options: INPUT_MODE_OPTIONS.filter(({ group }) => group === 'mini'),
	},
];

const PIN_OPTIONS: PinOption[] = Array.from({ length: NUM_PINS }, (_, i) => ({
	label: `GP${i}`,
	value: i,
}));

const INITIAL_STATE: FormState = {
	webConfigPins: [],
	usbModePins: [],
	bootModes: [
		{
			pins: [],
			inputMode: undefined,
			profileIndex: undefined,
		},
		{
			pins: [],
			inputMode: undefined,
			profileIndex: undefined,
		},
	],
	enabled: false,
};

const validationSchema: ObjectSchema<FormState> = object({
	webConfigPins: array().of(number().required()).min(1).required(),
	usbModePins: array().of(number().required()).min(1).required(),
	bootModes: array()
		.of(
			object({
				pins: array().of(number().required()).min(1, 'Required').required(),
				inputMode: number().required('Required'),
				profileIndex: number().optional(),
			}).required(),
		)
		.required(),
	enabled: boolean().required(),
}).test('pins-are-unique', 'Mapped GPIO pins must be unique', (value, context) => {
	let pinMappings = {
		webConfigPins: value.webConfigPins,
		usbModePins: value.usbModePins,
		...Object.fromEntries(value.bootModes.map((v, i) => [`bootModes.${i}.pins`, v.pins])),
	};
	let seen: { [key: number]: string[] } = {};
	for (const [key, pins] of Object.entries(pinMappings)) {
		let mask = arrayToMask(pins);
		if (mask == -1) {
			continue;
		}
		if (!(mask in seen)) {
			seen[mask] = [key];
		} else {
			seen[mask].push(key);
		}
	}
	console.log(context.path);
	let passed = true;
	for (const a of Object.values(seen)) {
		if (a.length > 1) {
			passed = false;
			for (const k of a) {
				throw context.createError({ path: k });
			}
		}
	}
	return passed;
});

function maskToArray(mask: number) {
	let s: number[] = [];
	if (mask === -1) {
		return s;
	}
	for (let i = 0; i < NUM_PINS; i++) {
		if ((1 << i) & mask) {
			s.push(i);
		}
	}
	return s;
}

function arrayToMask(pins: number[]) {
	if (pins.length == 0) {
		return -1;
	}
	return [...pins].reduce((mask, v) => mask | (1 << v), 0);
}

async function fetchBootModeOptions() {
	return await WebApi.getBootModeOptions().then(({ data }: { data: APIResponseData }) => {
		let { enabled, webConfigPinMask, usbModePinMask, inputModeMappings } = data;
		let state: FormState = {
			enabled: enabled,
			webConfigPins: maskToArray(webConfigPinMask),
			usbModePins: maskToArray(usbModePinMask),
			bootModes: Array(),
		};

		for (const m of inputModeMappings) {
			if (m.inputMode == -1) {
				continue;
			}
			state.bootModes.push({
				pins: maskToArray(m.pinMask),
				inputMode: m.inputMode as InputMode,
				profileIndex: m.profileNumber == 0 ? undefined : m.profileNumber - 1,
			});
		}
		return state;
	});
}

const saveBootModeOptions = async (state: FormState) => {
	const postData: APIResponseData = {
		webConfigPinMask: arrayToMask(state.webConfigPins),
		usbModePinMask: arrayToMask(state.usbModePins),
		enabled: state.enabled,
		inputModeMappings: Object.entries(state.bootModes).map(([_, m], _i) => ({
			pinMask: arrayToMask(m.pins),
			inputMode: m.inputMode === undefined ? 0 : m.inputMode,
			profileNumber: m.profileIndex === undefined ? 0 : m.profileIndex + 1,
		})),
	};
	return WebApi.setBootModeOptions(postData);
};

function BootModeSelect({ name }: { name: string }) {
	const [field, meta] = useField<number>(name);
	const { setFieldValue } = useFormikContext();

	const { getAvailablePeripherals } = useContext(AppContext);
	const { t } = useTranslation('');

	const value = INPUT_MODE_OPTIONS.find(({ value }) => value === field.value);
	const usbAvailable: boolean = getAvailablePeripherals('usb');

	const isOptionDisabled = (option: InputModeOptions) => {
		return option.required.includes('usb') && !usbAvailable;
	};

	const getOptionLabel = (option: InputModeOptions) => {
		return (
			t(`SettingsPage:${option.labelKey}`) +
			(isOptionDisabled(option) ? ' (USB peripheral not enabled)' : '')
		);
	};

	const onChange = (option: SingleValue<InputModeOptions>) => {
		setFieldValue(name, option?.value);
	};

	const isInvalid = meta.touched && meta.error ? true : false;

	return (
		<CustomSelect
			isClearable={false}
			isMulti={false}
			options={GROUPED_OPTIONS}
			isOptionDisabled={isOptionDisabled}
			isDisabled={false}
			getOptionLabel={getOptionLabel}
			onChange={onChange}
			value={value}
			isInvalid={isInvalid}
		/>
	);
}

function PinSelect({ name }: { name: string }) {
	const [field, meta] = useField<number[]>(name);
	const { setFieldValue } = useFormikContext();

	const values = PIN_OPTIONS.filter(({ value }) => field.value.includes(value));
	const isInvalid = meta.touched && meta.error ? true : false;

	const onChange = (_: MultiValue<PinOption>, action: ActionMeta<PinOption>) => {
		if (action.action === 'select-option' && action.option !== undefined) {
			setFieldValue(name, [...field.value, action.option.value]);
		} else if (action.action === 'remove-value') {
			setFieldValue(
				name,
				field.value.filter((value, _) => value != action.removedValue.value),
			);
		}
	};

	return (
		<div className="d-flex gap-2">
			<CustomSelect
				isClearable={false}
				isMulti={true}
				options={PIN_OPTIONS}
				isDisabled={false}
				onChange={onChange}
				value={values}
				isInvalid={isInvalid}
			/>
			<CaptureButton
				labels={['']}
				onChange={(_, pin) => {
					setFieldValue(name, [...field.value, pin]);
				}}
				small={true}
			/>
		</div>
	);
}

function ProfileSelect({ name }: { name: string }) {
	const [field] = useField<number | undefined>(name);
	const { setFieldValue } = useFormikContext();

	const profiles = useProfilesStore((state) => state.profiles);
	const profileOptions = profiles.map(({ profileLabel, enabled }, i) => ({
		label: profileLabel,
		value: i,
		disabled: !enabled,
	}));

	const value = profileOptions.find(({ value }) => value === field.value);

	const getLabel = (option: ProfileOption) => {
		const label = option.label ? option.label : `Profile ${option.value + 1}`;
		return label + (option.disabled ? ' (Disabled)' : '');
	};

	const onChange = (selected: any, action: ActionMeta<ProfileOption>) => {
		if (action.action === 'clear') {
			setFieldValue(name, undefined);
		} else if (action.action === 'select-option') {
			setFieldValue(name, selected.value);
		}
	};

	return (
		<CustomSelect
			isClearable={true}
			isMulti={false}
			options={profileOptions}
			getOptionLabel={getLabel}
			isOptionDisabled={(option) => option.disabled}
			onChange={onChange}
			placeholder="Last Used"
			value={value}
		/>
	);
}

function FormRow({
	className,
	col0,
	col1,
	col2,
	col3,
}: {
	className: string;
	col0?: ReactNode;
	col1?: ReactNode;
	col2?: ReactNode;
	col3?: ReactNode;
}) {
	return (
		<Row className={className}>
			<Col sm={3}>{col0}</Col>
			<Col>{col1}</Col>
			<Col sm={3}>{col2}</Col>
			<Col md="auto">{col3}</Col>
		</Row>
	);
}

function DynamicBootModeRow({ name, remove }: { name: string; remove: () => void }) {
	const [_inputMode, inputModeMeta] = useField<number>(`${name}.inputMode`);
	const [_pins, pinsMeta] = useField<number[]>(`${name}.pins`);
	const inputError = !!inputModeMeta.error && inputModeMeta.touched;
	const pinsError = !!pinsMeta.error && pinsMeta.touched;

	return (
		<>
			<FormRow
				className="gx-2 mt-3 align-items-center"
				col0={<BootModeSelect name={`${name}.inputMode`} />}
				col1={<PinSelect name={`${name}.pins`} />}
				col2={<ProfileSelect name={`${name}.profileIndex`} />}
				col3={<Button onClick={remove}>{'✕'}</Button>}
			/>
			{(inputError || pinsError) && (
				<FormRow
					className="gx-2 mt-0 align-items-center"
					col0={
						<div className="ms-2 invalid-feedback d-block">
							{inputError && inputModeMeta.error}
						</div>
					}
					col1={
						<div className="ms-2 invalid-feedback d-block">
							{pinsError && pinsMeta.error}
						</div>
					}
				/>
			)}
		</>
	);
}

function FixedBootModeRow({ name, label }: { name: string; label: string }) {
	return (
		<FormRow
			className="gx-2 mb-3 align-items-center"
			col0={<label className="ms-2">{label}</label>}
			col1={<PinSelect name={name} />}
			col2={<CustomSelect isDisabled={true} placeholder="N/A" />}
			col3={<Button disabled={true}>{'✕'}</Button>}
		/>
	);
}

const BootModeForm = () => {
	const [bootModeOptions, setBootModeOptions] = useState(INITIAL_STATE);
	const [loadingBootModes, setLoadingBootModes] = useState(false);
	const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

	const loadingProfiles = useProfilesStore((state) => state.loadingProfiles);
	const fetchProfiles = useProfilesStore((state) => state.fetchProfiles);

	const { t } = useTranslation('');

	useEffect(() => {
		setLoadingBootModes(true);
		fetchBootModeOptions()
			.then((initialState) => {
				setBootModeOptions(initialState);
				setLoadingBootModes(false);
			})
			.catch((error) => {
				console.log(error);
				setErrorMessage('Failed to load boot mode options');
			});
		fetchProfiles();
	}, []);

	return (
		<div>
			{loadingBootModes || loadingProfiles ? (
				<div className="d-flex justify-content-center">
					<span className="spinner-border" />
				</div>
			) : (
				<Formik
					initialValues={bootModeOptions}
					enableReinitialize={true}
					onSubmit={saveBootModeOptions}
					validate={(state) => {
						validationSchema
							.validate(state, { abortEarly: false })
							.then(() => {})
							.catch((err) => {
								console.log(err);
								return err.inner.reduce((obj: any, e: any) => {
									if (!(e.path in obj)) obj[e.path] = [];
									obj[e.path] = obj[e.path].concat(e.errors);
									return obj;
								}, {});
							});
					}}
				>
					{({ values, handleSubmit }) => (
						<Form
							onSubmit={(e) => {
								e.preventDefault();
								handleSubmit();
							}}
						>
							<Container fluid className="p-0">
								<FormRow
									className="gx-2 mb-3 align-items-center"
									col0={<Form.Text className="muted ms-2">MODE</Form.Text>}
									col1={<Form.Text className="muted ms-2">GPIO PINS</Form.Text>}
									col2={<Form.Text className="muted ms-2">PROFILE</Form.Text>}
									col3={<Button className="invisible">{'✕'}</Button>}
								/>
								<hr />
								<FixedBootModeRow
									name="webConfigPins"
									label={t('Navigation:reboot-modal-button-web-config-label')}
								/>
								<FixedBootModeRow
									name="usbModePins"
									label={t('Navigation:reboot-modal-button-bootsel-label')}
								/>
								<FieldArray name="bootModes">
									{({ remove, push }) => (
										<div>
											{values.bootModes.map((_, index) => (
												<div key={index}>
													<DynamicBootModeRow
														name={`bootModes[${index}]`}
														remove={() => {
															remove(index);
														}}
													></DynamicBootModeRow>
												</div>
											))}
											<div className="d-flex justify-content-center">
												{values.bootModes.length < MAX_INPUT_MODES && (
													<Button
														className="mt-1"
														variant="outline"
														onClick={() =>
															push({
																pins: [],
																inputMode: undefined,
																profileIndex: undefined,
															})
														}
													>
														+ Add Mode
													</Button>
												)}
											</div>
										</div>
									)}
								</FieldArray>
								<Button type="submit">{t('Common:button-save-label')}</Button>
							</Container>
						</Form>
					)}
				</Formik>
			)}
		</div>
	);
};

export default function BootModeMappingPage() {
	const { t } = useTranslation('');
	return (
		<Section title={t('SettingsPage:boot-input-mode-label')}>
			<BootModeForm />
		</Section>
	);
}
