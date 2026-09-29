/**
 * Adobe Media Encoder's "Apple ProRes 4444 XQ" QuickTime system preset, verbatim
 * apart from LF line endings: the base every generated ProRes `.epr` is patched
 * from. Every `ParamIdentifier` the serializer patches must appear in it exactly
 * once.
 */
export const QUICKTIME_BASE_EPR = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
	<IngestPresetUserComments></IngestPresetUserComments>
	<IngestMetadataPreset></IngestMetadataPreset>
	<IngestMetadataEnabled>false</IngestMetadataEnabled>
	<IngestNamingPreset></IngestNamingPreset>
	<IngestNamingEnabled>false</IngestNamingEnabled>
	<IngestTranscodeExporterModuleName></IngestTranscodeExporterModuleName>
	<IngestTranscodePresetName></IngestTranscodePresetName>
	<IngestTranscodePath></IngestTranscodePath>
	<IngestTranscodeEnabled>false</IngestTranscodeEnabled>
	<IngestCopyVerificationType>-1</IngestCopyVerificationType>
	<IngestCopyPath></IngestCopyPath>
	<IngestCopyEnabled>false</IngestCopyEnabled>
	<IngestPreset>false</IngestPreset>
	<ExportXMPOptionKey>10</ExportXMPOptionKey>
	<StandardFilters Version="1">
		<MaximumFileSize>0</MaximumFileSize>
		<RenderAlphaOnly>false</RenderAlphaOnly>
		<CustomStartTime>-101606400000000000</CustomStartTime>
		<UseFrameBlending>false</UseFrameBlending>
		<UsePreview>false</UsePreview>
		<UseMaximumRenderQuality>false</UseMaximumRenderQuality>
		<DeinterlaceState>false</DeinterlaceState>
		<CropType>0</CropType>
		<CropRect>0,0,0,0</CropRect>
		<CropState>false</CropState>
		<TimeInterpolationType>0</TimeInterpolationType>
	</StandardFilters>
	<FolderDisplayPath></FolderDisplayPath>
	<DoEmulation>false</DoEmulation>
	<DoVideo>true</DoVideo>
	<DoAudio>true</DoAudio>
	<PresetID>85558b3f-00ec-48d3-a88e-fd8e78a042dd</PresetID>
	<CaptionParamContainer ObjectRef="96"/>
	<ExportParamContainer ObjectRef="1"/>
	<ExporterFileType>1299148630</ExporterFileType>
	<ExporterClassID>1061109567</ExporterClassID>
	<ExporterName></ExporterName>
	<PresetCreatorPostProc></PresetCreatorPostProc>
	<PresetCreatorApp>Premiere Pro (Beta)</PresetCreatorApp>
	<PresetUserComments></PresetUserComments>
	<PresetComments>($$$/AME/EncoderHost/Presets/85558b3f-00ec-48d3-a88e-fd8e78a042dd/PresetComments=Highest-quality version of Apple ProRes for 4:4:4:4 image sources. Frame Size, Frame Rate, Field Order, and Pixel Aspect are set automatically, based on properties of the source.)</PresetComments>
	<PresetName>($$$/AME/EncoderHost/Presets/85558b3f-00ec-48d3-a88e-fd8e78a042dd/PresetName=Apple ProRes 4444 XQ)</PresetName>
	<ExporterParamContainer ObjectID="1" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="2"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="2" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamTargetBitrate>0</ParamTargetBitrate>
		<ParamTargetID>0</ParamTargetID>
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="3"/>
		<ParamName></ParamName>
		<ParamIdentifier>0</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>10</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="3" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="4"/>
			<ParamContainerItem Index="1" ObjectRef="46"/>
			<ParamContainerItem Index="2" ObjectRef="75"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="4" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="5"/>
		<ParamIdentifier>ADBEVideoTabGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="5" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="6"/>
			<ParamContainerItem Index="1" ObjectRef="12"/>
			<ParamContainerItem Index="2" ObjectRef="24"/>
			<ParamContainerItem Index="3" ObjectRef="30"/>
			<ParamContainerItem Index="4" ObjectRef="33"/>
			<ParamContainerItem Index="5" ObjectRef="40"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="6" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="7"/>
		<ParamIdentifier>ADBEVideoCodecGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="7" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="8"/>
			<ParamContainerItem Index="1" ObjectRef="9"/>
			<ParamContainerItem Index="2" ObjectRef="10"/>
			<ParamContainerItem Index="3" ObjectRef="11"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="8" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoCodec</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1634743416</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="9" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoResolution</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="10" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEDNxHDAlphaType</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="11" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoCodecPrefsButton</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>7</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="12" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="13"/>
		<ParamIdentifier>ADBEBasicVideoGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="13" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="14"/>
			<ParamContainerItem Index="1" ObjectRef="15"/>
			<ParamContainerItem Index="2" ObjectRef="16"/>
			<ParamContainerItem Index="3" ObjectRef="17"/>
			<ParamContainerItem Index="4" ObjectRef="18"/>
			<ParamContainerItem Index="5" ObjectRef="19"/>
			<ParamContainerItem Index="6" ObjectRef="20"/>
			<ParamContainerItem Index="7" ObjectRef="21"/>
			<ParamContainerItem Index="8" ObjectRef="22"/>
			<ParamContainerItem Index="9" ObjectRef="23"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="14" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamArbData Encoding="base64" Checksum="1418562957">HQAAAA==</ParamArbData>
		<ParamIdentifier>ADBEVideoMatchSource</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>7</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="15" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoQuality</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>true</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>100</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="16" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoWidth</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1920</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="17" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoHeight</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1080</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="18" ClassID="8def7863-204e-4206-8791-54a78f15c66b" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoFPS</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>4</ParamType>
		<ParamValue>10160640000</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="19" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoFieldType</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>5</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="20" ClassID="8d9836e8-d00a-4a00-bfc0-dfbb73540736" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoAspect</ParamIdentifier>
		<ParamConstrainedListIsOptional>true</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>6</ParamOrdinalValue>
		<ParamType>11</ParamType>
		<ParamValue>1,1</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="21" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBERenderDeepColor</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>7</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>true</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="22" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEExportColorSpace</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>8</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="23" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoBitDepth</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>9</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>4</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="24" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="25"/>
		<ParamIdentifier>ADBEAdvancedVideoGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="25" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="26"/>
			<ParamContainerItem Index="1" ObjectRef="27"/>
			<ParamContainerItem Index="2" ObjectRef="28"/>
			<ParamContainerItem Index="3" ObjectRef="29"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="26" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEKeyframeEvery</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="27" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEExpandStills</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="28" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEReorderFrames</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="29" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEForceTCTimebase</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="30" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="31"/>
		<ParamIdentifier>ADBEVideoBitrateGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="31" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="32"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="32" ClassID="018cf63d-c58d-4d39-97df-36b6b2d6ef88" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoBitrate</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>3</ParamType>
		<ParamValue>1000.</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="33" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="34"/>
		<ParamIdentifier>ADBEVideoHinterGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="34" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="35"/>
			<ParamContainerItem Index="1" ObjectRef="36"/>
			<ParamContainerItem Index="2" ObjectRef="37"/>
			<ParamContainerItem Index="3" ObjectRef="38"/>
			<ParamContainerItem Index="4" ObjectRef="39"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="35" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoHinterBool</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="36" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoPayloadEncoding</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="37" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoHinterPacketSize</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1440</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="38" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoHinterPacketDurationLimit</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>100</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="39" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoHinterInterval</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1000</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="40" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="41"/>
		<ParamIdentifier>ADBEVideoVRGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>5</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="41" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="42"/>
			<ParamContainerItem Index="1" ObjectRef="43"/>
			<ParamContainerItem Index="2" ObjectRef="44"/>
			<ParamContainerItem Index="3" ObjectRef="45"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="42" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoVRDoExport</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="43" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoVRStereoscopic</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="44" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoVRHFOV</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>360</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="45" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEVideoVRVFOV</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>180</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="46" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="47"/>
		<ParamIdentifier>ADBEAudioTabGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="47" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="48"/>
			<ParamContainerItem Index="1" ObjectRef="52"/>
			<ParamContainerItem Index="2" ObjectRef="59"/>
			<ParamContainerItem Index="3" ObjectRef="63"/>
			<ParamContainerItem Index="4" ObjectRef="66"/>
			<ParamContainerItem Index="5" ObjectRef="69"/>
			<ParamContainerItem Index="6" ObjectRef="72"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="48" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="49"/>
		<ParamIdentifier>ADBEAudioCodecGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="49" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="50"/>
			<ParamContainerItem Index="1" ObjectRef="51"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="50" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioCodec</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="51" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioCodecPrefsButton</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>7</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="52" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="53"/>
		<ParamIdentifier>ADBEBasicAudioGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="53" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="54"/>
			<ParamContainerItem Index="1" ObjectRef="55"/>
			<ParamContainerItem Index="2" ObjectRef="56"/>
			<ParamContainerItem Index="3" ObjectRef="57"/>
			<ParamContainerItem Index="4" ObjectRef="58"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="54" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioCodec</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="55" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioCodecPrefsButton</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>7</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="56" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioRatePerSecond</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>48000</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="57" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioNumChannels</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>2</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="58" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioSampleType</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>1</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="59" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="60"/>
		<ParamIdentifier>ADBEAudioChannelConfigurationGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="60" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="61"/>
			<ParamContainerItem Index="1" ObjectRef="62"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="61" ClassID="b93e10ab-6079-493d-a2b4-c7feb4a510b0" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamArbData Encoding="base64" Checksum="648058267">eyJtQWxsb3dlZENoYW5uZWxMYXlvdXRWZWN0b3IiOltdLCJtQ2hhbm5lbExheW91dFZlY3RvciI6W1t7ImNoYW5uZWxsYWJlbCI6MTAwfSx7ImNoYW5uZWxsYWJlbCI6MTAxfV1dLCJtTWF4TnVtQXVkaW9DaGFubmVscyI6NSwibU1heE51bUF1ZGlvQ2hhbm5lbHNQZXJTdHJlYW0iOjUsIm1NYXhOdW1BdWRpb1N0cmVhbXMiOjUsIm1WZXJzaW9uIjoxfQ==</ParamArbData>
		<ParamIdentifier>ADBEAudioChannelConfiguration</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>9</ParamType>
	</ExporterParam>
	<ExporterParam ObjectID="62" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioStreamMonoDiscrete</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="63" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="64"/>
		<ParamIdentifier>ADBEAudioTrackLayoutGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="64" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="65"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="65" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioTrackLayout</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>65535</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="66" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="67"/>
		<ParamIdentifier>ADBEChannelLayoutGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="67" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="68"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="68" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEChannelLayout</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="69" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="70"/>
		<ParamIdentifier>ADBEAudioBitrateGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>5</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="70" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="71"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="71" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioBitrate</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="72" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="73"/>
		<ParamIdentifier>ADBEAudioAmbiGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>6</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="73" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="74"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="74" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAudioAmbiDoExport</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="75" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="76"/>
		<ParamIdentifier>ADBEAlternatesTabGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="76" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="77"/>
			<ParamContainerItem Index="1" ObjectRef="84"/>
			<ParamContainerItem Index="2" ObjectRef="87"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="77" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="78"/>
		<ParamIdentifier>ADBEAlternatesBasicGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="78" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="79"/>
			<ParamContainerItem Index="1" ObjectRef="80"/>
			<ParamContainerItem Index="2" ObjectRef="81"/>
			<ParamContainerItem Index="3" ObjectRef="82"/>
			<ParamContainerItem Index="4" ObjectRef="83"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="79" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesLoop</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="80" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesCompressHeader</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="81" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesAutoplay</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="82" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesStreamingBool</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="83" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesHintedMovieType</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="84" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="85"/>
		<ParamIdentifier>ADBEAlternatesSettingsGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="85" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="86"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="86" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesAlternateBool</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="87" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="88"/>
		<ParamIdentifier>ADBEAlternatesTargetDetailsGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>8</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="88" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="89"/>
			<ParamContainerItem Index="1" ObjectRef="90"/>
			<ParamContainerItem Index="2" ObjectRef="91"/>
			<ParamContainerItem Index="3" ObjectRef="92"/>
			<ParamContainerItem Index="4" ObjectRef="93"/>
			<ParamContainerItem Index="5" ObjectRef="94"/>
			<ParamContainerItem Index="6" ObjectRef="95"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="89" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesConnection</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="90" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesLanguage</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="91" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesPlatform</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="92" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesQuality</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="93" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesComputerPower</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="94" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesQTVersion</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>true</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>5</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="95" ClassID="a43ab77d-3a01-4173-b6ea-aeb9b4ae884b" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBEAlternatesServerPath</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>6</ParamOrdinalValue>
		<ParamType>6</ParamType>
		<ParamValue></ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="96" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="97"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="97" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamTargetBitrate>0</ParamTargetBitrate>
		<ParamTargetID>0</ParamTargetID>
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ExporterChildParams ObjectRef="98"/>
		<ParamName>Captions</ParamName>
		<ParamIdentifier>ADBECaptionTabGroup</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>false</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>10</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParamContainer ObjectID="98" ClassID="5c20a4a5-5e7c-4032-85b8-26ad4531fe7b" Version="1">
		<ContainedParamsVersion>1</ContainedParamsVersion>
		<ParamContainerItems Version="1">
			<ParamContainerItem Index="0" ObjectRef="99"/>
			<ParamContainerItem Index="1" ObjectRef="100"/>
			<ParamContainerItem Index="2" ObjectRef="101"/>
			<ParamContainerItem Index="3" ObjectRef="102"/>
			<ParamContainerItem Index="4" ObjectRef="103"/>
		</ParamContainerItems>
	</ExporterParamContainer>
	<ExporterParam ObjectID="99" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBECaptionExportOption</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>0</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="100" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBECaptionFormat</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>1</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="101" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBECaptionFrameRate</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>false</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>2</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>102</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="102" ClassID="9f049ab7-d48f-43e9-a8ca-4d7f21233625" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBECaptionStreamFormat</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>3</ParamOrdinalValue>
		<ParamType>2</ParamType>
		<ParamValue>0</ParamValue>
	</ExporterParam>
	<ExporterParam ObjectID="103" ClassID="d0f6b8af-8ddb-4381-acf8-3e817480d07d" Version="1">
		<ParamAuxType></ParamAuxType>
		<ParamAuxValue></ParamAuxValue>
		<ParamIdentifier>ADBESRTIncludeStyling</ParamIdentifier>
		<ParamConstrainedListIsOptional>false</ParamConstrainedListIsOptional>
		<IsFilePathString>false</IsFilePathString>
		<IsOptionalParamEnabled>false</IsOptionalParamEnabled>
		<IsOptionalParam>false</IsOptionalParam>
		<IsParamPairGroup>false</IsParamPairGroup>
		<ParamIsPassword>false</ParamIsPassword>
		<ParamIsMultiLine>false</ParamIsMultiLine>
		<ParamIsVerticallyAligned>false</ParamIsVerticallyAligned>
		<ParamIsHidden>true</ParamIsHidden>
		<ParamIsDisabled>true</ParamIsDisabled>
		<ParamIsIndependant>false</ParamIsIndependant>
		<ParamIsSlider>false</ParamIsSlider>
		<ParamFlags>0</ParamFlags>
		<ParamDontSerializeValue>false</ParamDontSerializeValue>
		<ParamOrdinalValue>4</ParamOrdinalValue>
		<ParamType>1</ParamType>
		<ParamValue>false</ParamValue>
	</ExporterParam>
</PremiereData>
`;
