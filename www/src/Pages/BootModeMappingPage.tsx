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

const schema: ObjectSchema<FormState> = object({
	webConfigPins: array().of(number().required()).min(1).required(),
	usbModePins: array().of(number().required()).min(1).required(),
	bootModes: array()
		.of(
			object({
				pins: array().of(number().required()).min(1).required(),
				inputMode: number().required(),
				profileIndex: number().optional(),
			}).required(),
		)
		.required(),
	enabled: boolean().required(),
});

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

const saveBootModeOptions = async (state: FormState) => {
	const postData: APIResponseData = {
		webConfigPinMask: setToMask(state.webConfigPins),
		usbModePinMask: setToMask(state.usbModePins),
		enabled: state.enabled,
		inputModeMappings: Object.entries(state.bootModes).map(([_, m], _i) => ({
			pinMask: setToMask(m.pins),
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

	const values = PIN_OPTIONS.filter(({ value }) => value in field.value);
	let errorMessage = 'Mapped GPIO pins cannot contain duplicates';

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
	const isInvalid = meta.touched && meta.error ? true : false;

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
	col0,
	col1,
	col2,
	col3,
}: {
	col0?: ReactNode;
	col1?: ReactNode;
	col2?: ReactNode;
	col3?: ReactNode;
}) {
	return (
		<Row className="gx-2 mb-3 align-items-center">
			<Col sm={3}>{col0}</Col>
			<Col>{col1}</Col>
			<Col sm={3}>{col2}</Col>
			<Col md="auto">{col3}</Col>
		</Row>
	);
}

function BootModeRow({ name, remove }: { name: string; remove: () => void }) {
	return (
		<FormRow
			col0={<BootModeSelect name={`${name}.inputMode`} />}
			col1={<PinSelect name={`${name}.pins`} />}
			col2={<ProfileSelect name={`${name}.profileIndex`} />}
			col3={<Button onClick={remove}>{'✕'}</Button>}
		/>
	);
}

function FixedBootModeRow({ name, label }: { name: string; label: string }) {
	return (
		<FormRow
			col0={<label className="ms-2">{label}</label>}
			col1={<PinSelect name={name} />}
			col2={<CustomSelect isDisabled={true} placeholder="N/A" />}
			col3={<Button disabled={true}>{'✕'}</Button>}
		/>
	);
}

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

function findDuplicates(bootModes: { [key: string]: BootModeMapping }) {
	let seen: { [key: number]: string[] } = {};
	for (const [key, mapping] of Object.entries(bootModes)) {
		let mask = arrayToMask(mapping.pins);
		if (mask == -1) {
			continue;
		}
		if (!(mask in seen)) {
			seen[mask] = [key];
		} else {
			seen[mask].push(key);
		}
	}
	return Object.values(seen)
		.filter((a) => a.length > 1)
		.flat();
}

function Slider({ name }: { name: string }) {
	const [field, meta] = useField(name);
	return <input {...field} {...meta} type="checkbox" />;
}

const BootModeForm = () => {
	const [bootModeOptions, setBootModeOptions] = useState(INITIAL_STATE);
	const [errorMessage, setErrorMessage] = useState('');
	const fetchProfiles = useProfilesStore((state) => state.fetchProfiles);

	const { t } = useTranslation('');

	useEffect(() => {
		WebApi.getBootModeOptions()
			.then(({ data }) => {
				setBootModeOptions(data);
			})
			.catch((error) => {
				console.log(error);
				setErrorMessage('Failed to load boot mode options');
			});
		fetchProfiles();
	}, []);

	return (
		<Formik
			initialValues={bootModeOptions}
			onSubmit={saveBootModeOptions}
			validationSchema={schema}
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
											<BootModeRow
												name={`bootModes.${index}`}
												remove={() => {
													remove(index);
												}}
											></BootModeRow>
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
